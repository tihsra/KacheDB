/**
 * Replication.js — Leader-Follower replication.
 *
 * WHAT IS REPLICATION?
 *   Replication means running multiple copies of your server where:
 *   - The LEADER accepts all writes and reads
 *   - FOLLOWERS sync from the leader and serve reads
 *
 *   WHY?
 *   1. READ SCALE — spread read load across multiple nodes
 *   2. FAULT TOLERANCE — if the leader crashes, a follower can take over
 *   3. LOW LATENCY — followers can be geographically closer to some clients
 *
 * HOW IT WORKS HERE:
 *
 *   Leader side:
 *   - Opens a second TCP port (default: leaderPort + 1000) for followers
 *   - When a follower connects:
 *     a. Send a full snapshot of the current store state
 *     b. From that point on, stream every write command in real time
 *   - Maintains a list of connected followers
 *
 *   Follower side:
 *   - Connects to the leader's replication port
 *   - Receives the initial snapshot → loads it into local store
 *   - Receives streamed commands → applies them to local store
 *   - If disconnected → reconnects and re-syncs from scratch
 *
 * REPLICATION PROTOCOL (our custom format, not RESP):
 *   We use newline-delimited JSON over a persistent TCP connection.
 *
 *   Leader → Follower messages:
 *   { "type": "snapshot", "data": <store JSON>, "expiry": <expiry JSON> }
 *   { "type": "command",  "args": ["SET", "foo", "bar"] }
 *   { "type": "ping" }   (keepalive every 10s)
 *
 *   Follower → Leader messages:
 *   { "type": "ready" }  (after snapshot is applied)
 *   { "type": "pong" }
 *
 * CONSISTENCY MODEL:
 *   This is ASYNCHRONOUS replication — the leader does not wait for
 *   followers to acknowledge before returning OK to the client.
 *   This means followers can lag behind (replication lag).
 *   Advantage: low write latency on the leader.
 *   Risk: if the leader crashes, the most recent writes may not have
 *   reached all followers yet → potential data loss of milliseconds.
 *   Redis uses the same model by default.
 *
 *   SYNCHRONOUS replication (like PostgreSQL's synchronous_commit) waits
 *   for at least one follower to acknowledge before returning OK.
 *   Safer but slower. Worth knowing the tradeoff for interviews.
 *
 * REPLICATION OFFSET:
 *   Each leader command is assigned an incrementing offset number.
 *   Followers track which offset they're at. If a follower reconnects
 *   after a brief disconnect, it can ask the leader for commands after
 *   its last known offset (PARTIAL RESYNC). If it's been disconnected
 *   too long and the leader doesn't have those commands in memory,
 *   it does a FULL RESYNC (send full snapshot again).
 *   Our implementation always does full resync for simplicity.
 */

const net  = require('net');

// ─── Leader ──────────────────────────────────────────────────────────────────

class Leader {
  /**
   * @param {number}  replPort — TCP port for follower connections
   * @param {Store}   store    — reference to the leader's store
   * @param {Snapshot} snapshot — to generate the initial sync snapshot
   */
  constructor(replPort, store, snapshot) {
    this._replPort  = replPort;
    this._store     = store;
    this._snapshot  = snapshot;
    this._server    = null;
    this._followers = new Map(); // socket → { id, offset, ready }
    this._offset    = 0;        // monotonically increasing write counter
    this._nextId    = 1;
  }

  // ─── Start / Stop ────────────────────────────────────────────────────────────

  start() {
    this._server = net.createServer((socket) => {
      this._handleFollower(socket);
    });

    this._server.listen(this._replPort, () => {
      console.log(`[Leader] Replication port open on :${this._replPort}`);
    });

    // Keepalive pings every 10 seconds
    setInterval(() => this._pingFollowers(), 10_000).unref();
  }

  stop() {
    for (const [socket] of this._followers) {
      socket.destroy();
    }
    this._followers.clear();
    if (this._server) this._server.close();
  }

  // ─── Follower Connection ─────────────────────────────────────────────────────

  _handleFollower(socket) {
    const id = this._nextId++;
    const followerInfo = { id, offset: 0, ready: false };
    this._followers.set(socket, followerInfo);

    console.log(`[Leader] Follower #${id} connected from ${socket.remoteAddress}:${socket.remotePort}`);

    socket.on('data', (data) => {
      // Parse follower messages (pong, ready)
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') {
            followerInfo.ready = true;
            console.log(`[Leader] Follower #${id} is ready (snapshot applied)`);
          }
        } catch (_) {}
      }
    });

    socket.on('close', () => {
      this._followers.delete(socket);
      console.log(`[Leader] Follower #${id} disconnected`);
    });

    socket.on('error', (err) => {
      console.warn(`[Leader] Follower #${id} error: ${err.message}`);
      this._followers.delete(socket);
    });

    // Send initial snapshot immediately
    this._sendSnapshot(socket, followerInfo);
  }

  /**
   * Send the full store state to a newly connected follower.
   * After this, the follower is up-to-date and we start streaming.
   */
  _sendSnapshot(socket, followerInfo) {
    const storeData = this._store.toJSON();

    const msg = JSON.stringify({
      type   : 'snapshot',
      offset : this._offset,
      ...storeData,  // data + expiry
    });

    socket.write(msg + '\n');
    followerInfo.offset = this._offset;
    console.log(`[Leader] Sent snapshot to follower #${followerInfo.id} (${Object.keys(storeData.data).length} keys)`);
  }

  // ─── Stream Commands ─────────────────────────────────────────────────────────

  /**
   * Called by CommandProcessor after every successful write.
   * Broadcasts the command to all ready followers.
   *
   * @param {string[]} args — e.g. ["SET", "foo", "bar"]
   */
  broadcast(args) {
    this._offset++;

    if (this._followers.size === 0) return;

    const msg = JSON.stringify({
      type   : 'command',
      offset : this._offset,
      args,
    });

    for (const [socket, info] of this._followers) {
      if (!info.ready) continue; // don't stream to followers still loading snapshot
      try {
        socket.write(msg + '\n');
        info.offset = this._offset;
      } catch (e) {
        console.warn(`[Leader] Failed to write to follower #${info.id}: ${e.message}`);
      }
    }
  }

  _pingFollowers() {
    const ping = JSON.stringify({ type: 'ping' }) + '\n';
    for (const [socket, info] of this._followers) {
      try {
        socket.write(ping);
      } catch (_) {}
    }
  }

  getStats() {
    return {
      followerCount  : this._followers.size,
      replicationPort: this._replPort,
      offset         : this._offset,
      followers      : [...this._followers.values()].map(f => ({
        id    : f.id,
        offset: f.offset,
        ready : f.ready,
        lag   : this._offset - f.offset,
      })),
    };
  }
}

// ─── Follower ────────────────────────────────────────────────────────────────

class Follower {
  /**
   * @param {string}           leaderHost   — leader's hostname
   * @param {number}           leaderReplPort — leader's replication port
   * @param {Store}            store        — this follower's store
   * @param {CommandProcessor} processor    — to apply commands from leader
   */
  constructor(leaderHost, leaderReplPort, store, processor) {
    this._leaderHost     = leaderHost;
    this._leaderReplPort = leaderReplPort;
    this._store          = store;
    this._processor      = processor;
    this._socket         = null;
    this._buffer         = '';
    this._offset         = 0;
    this._connected      = false;
    this._reconnectTimer = null;
  }

  // ─── Connect ─────────────────────────────────────────────────────────────────

  connect() {
    console.log(`[Follower] Connecting to leader at ${this._leaderHost}:${this._leaderReplPort}`);

    this._socket = net.createConnection(this._leaderReplPort, this._leaderHost);

    this._socket.on('connect', () => {
      this._connected = true;
      console.log('[Follower] Connected to leader');
    });

    this._socket.on('data', (chunk) => {
      this._buffer += chunk.toString();
      this._processBuffer();
    });

    this._socket.on('close', () => {
      this._connected = false;
      console.log('[Follower] Disconnected from leader — reconnecting in 5s');
      this._scheduleReconnect();
    });

    this._socket.on('error', (err) => {
      console.warn(`[Follower] Connection error: ${err.message}`);
      this._connected = false;
    });
  }

  disconnect() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._socket) this._socket.destroy();
    this._connected = false;
  }

  // ─── Message Processing ──────────────────────────────────────────────────────

  /**
   * Process newline-delimited JSON messages from the leader.
   * Handles partial reads by buffering.
   */
  _processBuffer() {
    const lines = this._buffer.split('\n');

    // The last element may be a partial line — keep it in the buffer
    this._buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (e) {
        console.warn(`[Follower] Failed to parse message: ${e.message}`);
      }
    }
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'snapshot':
        this._applySnapshot(msg);
        break;

      case 'command':
        this._applyCommand(msg);
        break;

      case 'ping':
        // Respond with pong
        if (this._socket && !this._socket.destroyed) {
          this._socket.write(JSON.stringify({ type: 'pong' }) + '\n');
        }
        break;

      default:
        console.warn(`[Follower] Unknown message type: ${msg.type}`);
    }
  }

  /**
   * Apply a full snapshot from the leader — replaces all local state.
   */
  _applySnapshot(msg) {
    this._store.fromJSON({
      data   : msg.data   || {},
      expiry : msg.expiry || {},
    });
    this._offset = msg.offset || 0;

    const keyCount = Object.keys(msg.data || {}).length;
    console.log(`[Follower] Applied snapshot: ${keyCount} keys, offset ${this._offset}`);

    // Tell the leader we're ready to receive streamed commands
    if (this._socket && !this._socket.destroyed) {
      this._socket.write(JSON.stringify({ type: 'ready' }) + '\n');
    }
  }

  /**
   * Apply a single command from the leader to the local store.
   * fromReplication=true tells CommandProcessor to skip WAL write.
   */
  _applyCommand(msg) {
    const result = this._processor.process(msg.args, true /* fromReplication */);
    this._offset = msg.offset;

    if (result instanceof Error) {
      console.warn(`[Follower] Command failed during replication: ${result.message}`);
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._buffer = '';
      this.connect();
    }, 5000);
  }

  getStats() {
    return {
      connected      : this._connected,
      leaderHost     : this._leaderHost,
      leaderReplPort : this._leaderReplPort,
      offset         : this._offset,
    };
  }
}

module.exports = { Leader, Follower };
