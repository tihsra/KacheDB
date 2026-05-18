/**
 * CommandProcessor.js — Routes parsed RESP commands to Store operations.
 *
 * This is the "dispatcher" layer. It receives a parsed command array
 * like ["SET", "foo", "bar", "EX", "30"] and calls the appropriate
 * Store method with validated arguments.
 *
 * RESPONSIBILITIES:
 *   - Argument count validation
 *   - Type coercion (string "42" → number 42 where needed)
 *   - Error formatting (wrong type, wrong arg count, unknown command)
 *   - Delegating to Store for the actual operation
 *   - Notifying the WAL about write commands (for replication)
 *
 * WHAT IT DOES NOT DO:
 *   - Does not touch the network (that's ClientHandler's job)
 *   - Does not encode responses (caller handles that with RespEncoder)
 *   - Does not manage expiry timers (that's ExpiryManager)
 */

class CommandProcessor {
  /**
   * @param {Store}    store  — the shared key-value store
   * @param {WAL}      wal    — write-ahead log (nullable — followers don't write WAL)
   * @param {Function} onWrite — callback for replication: (rawCommand) => void
   */
  constructor(store, wal = null, onWrite = null) {
    this._store   = store;
    this._wal     = wal;
    this._onWrite = onWrite; // called after every successful write command

    // Total commands processed (for stats)
    this._commandCount = 0;

    // Build the command dispatch table
    // Maps command name (uppercase) → handler function
    this._commands = {
      // ── Reads ──────────────────────────────────────────────────────────
      'GET'      : (args) => this._get(args),
      'EXISTS'   : (args) => this._exists(args),
      'TTL'      : (args) => this._ttl(args),
      'KEYS'     : (args) => this._keys(args),
      'DBSIZE'   : (args) => this._dbsize(args),
      'TYPE'     : (args) => this._type(args),

      // ── Writes ─────────────────────────────────────────────────────────
      'SET'      : (args) => this._set(args),
      'DEL'      : (args) => this._del(args),
      'EXPIRE'   : (args) => this._expire(args),
      'PERSIST'  : (args) => this._persist(args),
      'INCR'     : (args) => this._incr(args),
      'DECR'     : (args) => this._decr(args),
      'APPEND'   : (args) => this._append(args),
      'FLUSHALL' : (args) => this._flushAll(args),
      'MSET'     : (args) => this._mset(args),

      // ── Multi-read ─────────────────────────────────────────────────────
      'MGET'     : (args) => this._mget(args),

      // ── Server ─────────────────────────────────────────────────────────
      'PING'     : (args) => this._ping(args),
      'ECHO'     : (args) => this._echo(args),
      'INFO'     : (args) => this._info(args),
      'COMMAND'  : (args) => this._command(args),
    };

    // Which commands mutate state (need WAL + replication notification)
    this._writeCommands = new Set([
      'SET', 'DEL', 'EXPIRE', 'PERSIST', 'INCR', 'DECR',
      'APPEND', 'FLUSHALL', 'MSET',
    ]);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Process a parsed command.
   * @param {string[]} args — e.g. ["SET", "foo", "bar"]
   * @param {boolean}  fromReplication — if true, skip WAL write (avoid double-logging)
   * @returns {*} — the result value (to be encoded by the caller)
   */
  process(args, fromReplication = false) {
    this._commandCount++;

    if (!args || args.length === 0) {
      return new Error('ERR empty command');
    }

    if (args[0] === '__PARSE_ERROR__') {
      return new Error(args[1] || 'Parse error');
    }

    const name    = args[0].toUpperCase();
    const cmdArgs = args.slice(1); // arguments without the command name
    const handler = this._commands[name];

    if (!handler) {
      return new Error(`ERR unknown command '${name}'`);
    }

    // Execute the command
    const result = handler(cmdArgs);

    // If it's a write command and succeeded, log to WAL and notify replicas
    if (!(result instanceof Error) && this._writeCommands.has(name) && !fromReplication) {
      const raw = args.join(' ');
      if (this._wal) {
        this._wal.append(args);
      }
      if (this._onWrite) {
        this._onWrite(args);
      }
    }

    return result;
  }

  getCommandCount() {
    return this._commandCount;
  }

  // ─── Read Handlers ───────────────────────────────────────────────────────────

  _get([key]) {
    if (!key) return new Error('ERR wrong number of arguments for GET');
    return this._store.get(key); // returns value or null
  }

  _exists(keys) {
    if (keys.length === 0) return new Error('ERR wrong number of arguments for EXISTS');
    return this._store.exists(...keys);
  }

  _ttl([key]) {
    if (!key) return new Error('ERR wrong number of arguments for TTL');
    return this._store.ttl(key);
  }

  _keys([pattern = '*']) {
    return this._store.keys(pattern);
  }

  _dbsize([]) {
    return this._store.dbSize();
  }

  _type([key]) {
    if (!key) return new Error('ERR wrong number of arguments for TYPE');
    const val = this._store.get(key);
    if (val === null) return 'none';
    // We only support string type in this implementation
    return 'string';
  }

  _mget(keys) {
    if (keys.length === 0) return new Error('ERR wrong number of arguments for MGET');
    return keys.map(k => this._store.get(k));
  }

  // ─── Write Handlers ──────────────────────────────────────────────────────────

  /**
   * SET key value [EX seconds] [PX milliseconds] [NX] [XX]
   *
   * Options:
   *   EX  seconds  — Set expiry in seconds
   *   PX  ms       — Set expiry in milliseconds
   *   NX           — Only set if key does NOT exist
   *   XX           — Only set if key DOES exist
   */
  _set([key, value, ...opts]) {
    if (!key || value === undefined) {
      return new Error('ERR wrong number of arguments for SET');
    }

    let expirySeconds = null;
    let nx = false; // only set if not exists
    let xx = false; // only set if exists

    // Parse options
    for (let i = 0; i < opts.length; i++) {
      const opt = opts[i].toUpperCase();
      if (opt === 'EX') {
        const secs = parseInt(opts[++i], 10);
        if (isNaN(secs) || secs <= 0) return new Error('ERR invalid expire time');
        expirySeconds = secs;
      } else if (opt === 'PX') {
        const ms = parseInt(opts[++i], 10);
        if (isNaN(ms) || ms <= 0) return new Error('ERR invalid expire time');
        expirySeconds = ms / 1000;
      } else if (opt === 'NX') {
        nx = true;
      } else if (opt === 'XX') {
        xx = true;
      }
    }

    // NX: only set if key does NOT exist
    if (nx && this._store.exists(key) > 0) return null; // Redis returns nil

    // XX: only set if key DOES exist
    if (xx && this._store.exists(key) === 0) return null; // Redis returns nil

    return this._store.set(key, value, expirySeconds);
  }

  _del(keys) {
    if (keys.length === 0) return new Error('ERR wrong number of arguments for DEL');
    return this._store.del(...keys);
  }

  _expire([key, seconds]) {
    if (!key || seconds === undefined) {
      return new Error('ERR wrong number of arguments for EXPIRE');
    }
    const secs = parseInt(seconds, 10);
    if (isNaN(secs)) return new Error('ERR value is not an integer');
    return this._store.expire(key, secs);
  }

  _persist([key]) {
    if (!key) return new Error('ERR wrong number of arguments for PERSIST');
    return this._store.persist(key);
  }

  _incr([key]) {
    if (!key) return new Error('ERR wrong number of arguments for INCR');
    return this._store.incr(key);
  }

  _decr([key]) {
    if (!key) return new Error('ERR wrong number of arguments for DECR');
    return this._store.decr(key);
  }

  _append([key, value]) {
    if (!key || value === undefined) return new Error('ERR wrong number of arguments for APPEND');
    return this._store.append(key, value);
  }

  _flushAll([]) {
    return this._store.flushAll();
  }

  /**
   * MSET key1 value1 key2 value2 ...
   * Sets multiple keys atomically. Always returns OK.
   */
  _mset(args) {
    if (args.length === 0 || args.length % 2 !== 0) {
      return new Error('ERR wrong number of arguments for MSET');
    }
    for (let i = 0; i < args.length; i += 2) {
      this._store.set(args[i], args[i + 1]);
    }
    return 'OK';
  }

  // ─── Server Handlers ─────────────────────────────────────────────────────────

  _ping([msg]) {
    return msg !== undefined ? msg : 'PONG';
  }

  _echo([msg]) {
    if (msg === undefined) return new Error('ERR wrong number of arguments for ECHO');
    return msg;
  }

  _info([]) {
    const storeStats  = this._store.getStats();
    const memUsage    = process.memoryUsage();
    const uptime      = Math.floor(process.uptime());

    const lines = [
      '# Server',
      `uptime_in_seconds:${uptime}`,
      `process_id:${process.pid}`,
      '',
      '# Keyspace',
      `db0:keys=${storeStats.keyCount}`,
      '',
      '# Stats',
      `total_commands_processed:${storeStats.totalCommands}`,
      `keyspace_hits:${storeStats.hits}`,
      `keyspace_misses:${storeStats.misses}`,
      `hit_rate_percent:${storeStats.hitRate}`,
      '',
      '# Memory',
      `used_memory_bytes:${memUsage.heapUsed}`,
      `used_memory_rss_bytes:${memUsage.rss}`,
    ];

    return lines.join('\r\n');
  }

  _command([]) {
    // Return list of supported commands (simplified)
    return Object.keys(this._commands);
  }
}

module.exports = CommandProcessor;
