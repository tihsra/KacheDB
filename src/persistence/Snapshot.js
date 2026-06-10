/**
 * Snapshot.js — periodic full dump of the store to disk.
 *
 * A snapshot is the whole store (keys, values, expiry) serialized to JSON, taken
 * every few minutes. On restart the newest snapshot is loaded and only the WAL
 * entries written after it are replayed, which keeps startup fast no matter how
 * long the server has run.
 *
 * Format: { version, timestamp, walOffset, data, expiry }.
 *
 * Writes go to a temp file and are then renamed into place. rename() is atomic on
 * POSIX, so a crash mid-write can't leave a corrupt snapshot. The last 3 are kept.
 */

const fs   = require('fs');
const path = require('path');

const SNAPSHOT_VERSION  = 1;
const SNAPSHOT_INTERVAL = 5 * 60 * 1000; // every 5 minutes
const MAX_SNAPSHOTS     = 3;              // keep last 3

class Snapshot {
  /**
   * @param {string} dataDir — directory to store snapshot files
   * @param {Store}  store   — the store to snapshot
   * @param {WAL}    wal     — needed to record WAL offset at snapshot time
   */
  constructor(dataDir, store, wal) {
    this._dataDir  = dataDir;
    this._store    = store;
    this._wal      = wal;
    this._timer    = null;
    this._snapshotCount = 0;

    // Ensure the data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Start the periodic snapshot timer.
   */
  startAutoSnapshot() {
    this._timer = setInterval(() => {
      this.save();
    }, SNAPSHOT_INTERVAL);
    this._timer.unref();
    console.log(`[Snapshot] Auto-snapshot every ${SNAPSHOT_INTERVAL / 1000}s`);
  }

  stopAutoSnapshot() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  /**
   * Take a snapshot of the current store state.
   * Returns the path of the written snapshot file.
   *
   * LEARNING POINT: Notice the order of operations:
   *   1. Export store state (this is a point-in-time read)
   *   2. Record WAL offset AFTER the export
   *   3. Write to temp file
   *   4. Rename temp → final (atomic)
   *   5. THEN truncate WAL
   * Step 5 must come after step 4. If we truncate before the rename and then
   * crash, we have no snapshot and no WAL — data is lost.
   */
  save() {
    const startMs     = Date.now();
    const storeData   = this._store.toJSON();
    // INVARIANT: this snapshot reflects every write up to NOW, and below we
    // truncate the WAL to zero. So on restart the WAL contains ONLY writes that
    // happened after this snapshot, starting at byte 0. The stored offset must
    // therefore be 0 — NOT currentOffset(). Storing the pre-truncate size here
    // was a data-loss bug: replay(size) skipped the first `size` bytes of the
    // freshly-truncated WAL, silently discarding all post-snapshot writes.
    const walOffset = 0;

    const snapshot = {
      version   : SNAPSHOT_VERSION,
      timestamp : startMs,
      walOffset,
      ...storeData,  // spreads { data, expiry }
    };

    const filename   = `snapshot-${startMs}.json`;
    const finalPath  = path.join(this._dataDir, filename);
    const tempPath   = finalPath + '.tmp';

    // Write to temp file first
    fs.writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf8');

    // Atomic rename — this is the commit point
    fs.renameSync(tempPath, finalPath);

    // Truncate the WAL. Everything it contained is now durably in the snapshot,
    // so the WAL restarts empty and future writes are the only thing in it.
    if (this._wal) {
      this._wal.truncate();
    }

    this._snapshotCount++;
    const elapsed = Date.now() - startMs;
    const keyCount = Object.keys(storeData.data).length;
    console.log(`[Snapshot] Saved ${keyCount} keys to ${filename} in ${elapsed}ms`);

    // Clean up old snapshots
    this._pruneOldSnapshots();

    return finalPath;
  }

  // ─── Load ────────────────────────────────────────────────────────────────────

  /**
   * Load the most recent snapshot and apply it to the store.
   * Returns the WAL offset stored in the snapshot (so the server knows
   * where to start WAL replay).
   *
   * Returns 0 if no snapshot exists.
   */
  load() {
    const latest = this._findLatestSnapshot();
    if (!latest) {
      console.log('[Snapshot] No snapshot found — starting with empty store');
      return 0;
    }

    let raw;
    try {
      raw = fs.readFileSync(latest, 'utf8');
    } catch (e) {
      console.error(`[Snapshot] Failed to read snapshot: ${e.message}`);
      return 0;
    }

    let snapshot;
    try {
      snapshot = JSON.parse(raw);
    } catch (e) {
      console.error(`[Snapshot] Corrupt snapshot file: ${e.message}`);
      return 0;
    }

    if (snapshot.version !== SNAPSHOT_VERSION) {
      console.warn(`[Snapshot] Version mismatch: ${snapshot.version} vs ${SNAPSHOT_VERSION}`);
    }

    // Restore the store
    this._store.fromJSON({
      data   : snapshot.data   || {},
      expiry : snapshot.expiry || {},
    });

    const keyCount = Object.keys(snapshot.data || {}).length;
    const age      = Math.floor((Date.now() - snapshot.timestamp) / 1000);
    console.log(`[Snapshot] Loaded ${keyCount} keys from ${path.basename(latest)} (${age}s ago)`);

    return snapshot.walOffset || 0;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Find the most recent snapshot file by timestamp in filename.
   */
  _findLatestSnapshot() {
    const files = this._getSnapshotFiles();
    if (files.length === 0) return null;
    return files[files.length - 1]; // sorted ascending, last = newest
  }

  /**
   * Get all snapshot files sorted by timestamp (ascending).
   */
  _getSnapshotFiles() {
    if (!fs.existsSync(this._dataDir)) return [];

    return fs.readdirSync(this._dataDir)
      .filter(f => f.startsWith('snapshot-') && f.endsWith('.json'))
      .sort() // lexicographic sort works because timestamps are left-padded
      .map(f => path.join(this._dataDir, f));
  }

  /**
   * Delete old snapshots, keeping only the MAX_SNAPSHOTS most recent.
   */
  _pruneOldSnapshots() {
    const files = this._getSnapshotFiles();
    const toDelete = files.slice(0, Math.max(0, files.length - MAX_SNAPSHOTS));
    for (const file of toDelete) {
      fs.unlinkSync(file);
      console.log(`[Snapshot] Deleted old snapshot: ${path.basename(file)}`);
    }
  }

  getStats() {
    const files = this._getSnapshotFiles();
    return {
      snapshotCount  : this._snapshotCount,
      storedSnapshots: files.length,
      latestSnapshot : files.length > 0 ? path.basename(files[files.length - 1]) : null,
    };
  }
}

module.exports = Snapshot;
