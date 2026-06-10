/**
 * WAL.js — Write-Ahead Log.
 *
 * An append-only file on disk. Each write command is appended and the file is
 * fsync'd once a second, so writes survive a restart. On crash recovery the
 * latest snapshot is loaded and the WAL entries written after it are replayed.
 * Append-only keeps writes sequential and means a crash mid-append only leaves a
 * partial last line, which is detected and skipped during replay.
 *
 * Format: one JSON array per line, e.g.
 *   ["SET","user:1","Alice"]
 *   ["EXPIRE","user:1","3600"]
 *
 * fsync runs on a timer (the "everysec" mode), so a power loss can drop at most
 * the last second of writes. After a snapshot the log is truncated.
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

    // Read raw bytes and slice by BYTE offset, THEN decode as UTF-8. Reading as
    // a string and slicing by character index would corrupt entries whenever a
    // prior entry contained a multibyte value (offset is a byte count).
    const raw     = fs.readFileSync(this._filePath);
    const content = raw.toString('utf8', afterOffset);
    const lines   = content.split('\n');
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
