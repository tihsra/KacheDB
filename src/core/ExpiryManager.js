/**
 * ExpiryManager.js — Active expiry sweeper.
 *
 * Redis uses TWO expiry strategies working together:
 *
 * 1. LAZY EXPIRY (inside Store.get / Store.exists etc.)
 *    When you read a key, we check if it's expired right then.
 *    Cost: O(1) per read. Problem: keys that are never read again
 *    sit in memory forever even after they expire.
 *
 * 2. ACTIVE EXPIRY (this file)
 *    A background loop runs every SWEEP_INTERVAL_MS milliseconds.
 *    It scans the expiry map and deletes any keys that have passed
 *    their expiry time. This bounds memory usage for keys that are
 *    written but never read again.
 *
 * LEARNING POINT — Why not just sweep all keys every time?
 *   If you have 10 million keys, sweeping all of them every 100ms
 *   would block the event loop. Redis solves this by sampling:
 *   pick 20 random keys from the expiry set, delete the expired ones,
 *   if >25% were expired do it again immediately (probabilistic sweep).
 *   Our implementation does a full sweep since we're not at that scale,
 *   but the real Redis approach is worth knowing for interviews.
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
