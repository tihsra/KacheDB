/**
 * WAL.js — Write-Ahead Log.
 *
 * WHAT IS A WAL?
 *   A Write-Ahead Log (WAL) is an append-only file on disk. Before any
 *   write command is applied to the in-memory store, it is first written
 *   to the WAL file. If the server crashes:
 *
 *     1. Load the latest snapshot (fast full restore)
 *     2. Replay WAL entries written after that snapshot
 *     3. The store is back to exactly the state before the crash
 *
 *   This guarantees DURABILITY — the D in ACID.
 *
 * WHY APPEND-ONLY?
 *   Appending to a file is the fastest possible disk write — no seeking,
 *   no overwriting. It also means the WAL is always in a consistent state:
 *   if we crash mid-append, we get a partial last line which we detect
 *   and skip during replay.
 *
 * WAL vs SNAPSHOT:
 *   Snapshot: entire store state in one file. Fast to restore but:
 *     - Takes O(n) time and memory to create
 *     - Any writes after the last snapshot are lost on crash
 *   WAL: individual commands, one per line. Problems:
 *     - Replaying 10 million commands on startup is slow
 *   Solution: use BOTH. Snapshot gives fast baseline; WAL fills the gap.
 *
 * FILE FORMAT:
 *   One JSON array per line. Example:
 *     ["SET","user:1","Alice"]
 *     ["EXPIRE","user:1","3600"]
 *     ["DEL","user:2"]
 *   JSON is human-readable and trivially parseable. Redis uses a binary
 *   format (RDB) for the snapshot and a text format (AOF) for the log.
 *   We use JSON for both — simpler to understand.
 *
 * FSYNC BEHAVIOUR:
 *   We use { flag: 'a' } (append mode). Node.js buffers writes in the OS
 *   page cache. A crash of the Node process is fine — the OS will flush.
 *   A power failure before fsync() could lose recent entries.
 *   Redis offers three durability modes:
 *     always  — fsync after every write (safest, slowest)
 *     everysec — fsync once per second (good balance)
 *     no      — let the OS decide (fastest, risky)
 *   We implement "everysec" via a periodic fsync timer.
 */

const fs   = require('fs');
const path = require('path');

const FSYNC_INTERVAL_MS = 1000; // sync to disk every second

class WAL {
  /**
   * @param {string} filePath — path to the WAL file (e.g. "./data/wal.log")
   */
  constructor(filePath) {
    this._filePath  = filePath;
    this._fd        = null;   // file descriptor (kept open for fast appends)
    this._entryCount = 0;
    this._syncTimer  = null;
    this._dirty      = false; // true if there are unsynced writes
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Open (or create) the WAL file and start the fsync timer.
   */
  open() {
    // Ensure parent directory exists
    const dir = path.dirname(this._filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open in append mode. Creates the file if it doesn't exist.
    // 'a' flag: position at end, every write appends
    this._fd = fs.openSync(this._filePath, 'a');

    // Start the periodic fsync
    this._syncTimer = setInterval(() => {
      if (this._dirty) {
        fs.fsyncSync(this._fd);
        this._dirty = false;
      }
    }, FSYNC_INTERVAL_MS);
    this._syncTimer.unref();

    console.log(`[WAL] Opened: ${this._filePath}`);
  }

  /**
   * Flush and close the WAL file. Call during graceful shutdown.
   */
  close() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (this._fd !== null) {
      fs.fsyncSync(this._fd); // final flush
      fs.closeSync(this._fd);
      this._fd = null;
    }
    console.log(`[WAL] Closed. Total entries: ${this._entryCount}`);
  }

  // ─── Write ───────────────────────────────────────────────────────────────────

  /**
   * Append one command to the WAL.
   *
   * @param {string[]} args — e.g. ["SET", "foo", "bar"]
   *
   * IMPORTANT: This must be called BEFORE applying the command to the store.
   * Write-AHEAD means the log goes first. If we crash after writing the WAL
   * but before updating the store, replay will re-apply the command.
   * If we crash after updating the store but before writing WAL... the command
   * is silently lost. WAL-first prevents this.
   */
  append(args) {
    if (this._fd === null) {
      throw new Error('[WAL] Not open — call open() first');
    }

    const line   = JSON.stringify(args) + '\n';
    const buffer = Buffer.from(line, 'utf8');

    // Synchronous write to the file descriptor
    // We use sync here because we must guarantee the entry hits the OS
    // buffer before returning "OK" to the client.
    fs.writeSync(this._fd, buffer);

    this._entryCount++;
    this._dirty = true;
  }

  // ─── Replay ──────────────────────────────────────────────────────────────────

  /**
   * Read and parse all entries from the WAL file.
   * Called on startup to replay commands after loading a snapshot.
   *
   * @param {number} afterOffset — byte offset to start reading from.
   *                               Pass the snapshot's WAL offset to skip
   *                               entries already covered by the snapshot.
   * @returns {string[][]} — array of command arrays
   */
  replay(afterOffset = 0) {
    if (!fs.existsSync(this._filePath)) {
      console.log('[WAL] No WAL file found — starting fresh');
      return [];
    }

    const content = fs.readFileSync(this._filePath, 'utf8');
    const lines   = content.slice(afterOffset).split('\n');
    const entries = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue; // skip blank lines

      try {
        const parsed = JSON.parse(line);
        if (Array.isArray(parsed) && parsed.length > 0) {
          entries.push(parsed);
        }
      } catch (e) {
        // Partial write — the last line may be truncated if we crashed mid-write
        // Skip it and log a warning
        if (i < lines.length - 1) {
          // Not the last line — something is actually wrong
          console.warn(`[WAL] Skipping malformed entry at line ${i + 1}: ${line.slice(0, 50)}`);
        }
      }
    }

    console.log(`[WAL] Replayed ${entries.length} entries from offset ${afterOffset}`);
    return entries;
  }

  /**
   * Returns the current byte offset (size of the WAL file).
   * Stored in snapshots so we know where to resume WAL replay after a restart.
   */
  currentOffset() {
    if (!fs.existsSync(this._filePath)) return 0;
    return fs.statSync(this._filePath).size;
  }

  /**
   * Truncate the WAL file. Called after a snapshot is taken —
   * entries before the snapshot are no longer needed.
   *
   * LEARNING POINT: This is called "WAL compaction" or "log truncation".
   * Without it the WAL grows forever. PostgreSQL has a similar mechanism
   * called "checkpoint" that advances a pointer in the WAL ring.
   */
  truncate() {
    if (this._fd !== null) {
      fs.fsyncSync(this._fd);
      fs.closeSync(this._fd);
    }
    fs.writeFileSync(this._filePath, ''); // truncate to zero
    this._fd = fs.openSync(this._filePath, 'a');
    this._entryCount = 0;
    console.log('[WAL] Truncated after snapshot');
  }

  getStats() {
    return {
      filePath   : this._filePath,
      entryCount : this._entryCount,
      sizeBytes  : this.currentOffset(),
    };
  }
}

module.exports = WAL;
