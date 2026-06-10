/**
 * ExpiryManager.js — active expiry. Keys are also expired lazily on read inside
 * Store; this background loop runs every SWEEP_INTERVAL_MS and removes any keys
 * past their expiry, so keys that are written but never read again don't sit in
 * memory forever. It does a full sweep of the expiry map (fine at this scale).
 */

const SWEEP_INTERVAL_MS = 100; // sweep every 100ms — same as Redis default

class ExpiryManager {
  /**
   * @param {Store} store — reference to the shared Store instance
   * @param {WAL}   wal   — optional WAL reference (we don't log expiry sweeps,
   *                        but we need to know about them for replication)
   */
  constructor(store, onExpire = null) {
    this._store    = store;
    this._onExpire = onExpire; // optional callback: (key) => void
    this._timer    = null;
    this._running  = false;

    // Stats
    this._totalSwept = 0;
    this._sweepCount = 0;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Start the background sweep timer.
   * Uses setInterval — Node.js will keep the process alive as long as this runs.
   * Call stop() before exiting.
   */
  start() {
    if (this._running) return;
    this._running = true;

    this._timer = setInterval(() => {
      this._sweep();
    }, SWEEP_INTERVAL_MS);

    // unref() tells Node: "don't keep the process alive just for this timer"
    // This means if nothing else is running, the process can exit cleanly.
    this._timer.unref();

    console.log(`[ExpiryManager] Active sweep started (every ${SWEEP_INTERVAL_MS}ms)`);
  }

  /**
   * Stop the background sweep timer.
   * Called during graceful shutdown.
   */
  stop() {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._timer);
    this._timer = null;
    console.log(`[ExpiryManager] Stopped. Total swept: ${this._totalSwept} keys over ${this._sweepCount} sweeps`);
  }

  // ─── Sweep ───────────────────────────────────────────────────────────────────

  /**
   * One sweep cycle. Delegates to Store.sweepExpired() which does the
   * actual iteration and deletion. We just track stats here.
   */
  _sweep() {
    const swept = this._store.sweepExpired();
    this._totalSwept += swept;
    this._sweepCount++;
  }

  // ─── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    return {
      running      : this._running,
      intervalMs   : SWEEP_INTERVAL_MS,
      totalSwept   : this._totalSwept,
      sweepCount   : this._sweepCount,
    };
  }
}

module.exports = ExpiryManager;
