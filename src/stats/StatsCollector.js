/**
 * StatsCollector.js — Aggregates runtime stats for the React dashboard.
 *
 * Collects data from all subsystems and exposes it over WebSocket.
 * The React dashboard connects here to get live metrics.
 *
 * Stats tracked:
 *   - ops/sec (commands per second, rolling 1s window)
 *   - connected clients
 *   - total keys in store
 *   - hit rate (hits / (hits + misses))
 *   - memory usage (Node.js heap)
 *   - replication lag (if leader)
 *   - WAL size
 *   - uptime
 */

class StatsCollector {
  constructor() {
    this._startTime       = Date.now();
    this._commandsInWindow = 0; // commands in the last second
    this._opsPerSec       = 0;
    this._connectedClients = 0;

    // Rolling window for ops/sec calculation
    this._opsTimer = setInterval(() => {
      this._opsPerSec = this._commandsInWindow;
      this._commandsInWindow = 0;
    }, 1000);
    this._opsTimer.unref();

    // References to other subsystems (set by Server.js)
    this._store    = null;
    this._wal      = null;
    this._expiry   = null;
    this._leader   = null;
    this._follower = null;
  }

  // ─── Registration ─────────────────────────────────────────────────────────

  register({ store, wal, expiry, leader, follower }) {
    this._store    = store;
    this._wal      = wal;
    this._expiry   = expiry;
    this._leader   = leader;
    this._follower = follower;
  }

  // ─── Tracking ─────────────────────────────────────────────────────────────

  recordCommand() {
    this._commandsInWindow++;
  }

  setConnectedClients(n) {
    this._connectedClients = n;
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────

  /**
   * Returns a complete stats object for the dashboard.
   */
  collect() {
    const mem = process.memoryUsage();

    const storeStats  = this._store  ? this._store.getStats()  : {};
    const walStats    = this._wal    ? this._wal.getStats()     : {};
    const expiryStats = this._expiry ? this._expiry.getStats()  : {};
    const leaderStats = this._leader ? this._leader.getStats()  : null;
    const followerStats = this._follower ? this._follower.getStats() : null;

    return {
      timestamp        : Date.now(),
      uptimeSeconds    : Math.floor((Date.now() - this._startTime) / 1000),
      opsPerSec        : this._opsPerSec,
      connectedClients : this._connectedClients,

      keyspace: {
        keyCount  : storeStats.keyCount  || 0,
        hits      : storeStats.hits      || 0,
        misses    : storeStats.misses    || 0,
        hitRate   : storeStats.hitRate   || '0.0',
        totalCmds : storeStats.totalCommands || 0,
      },

      memory: {
        heapUsedMB : (mem.heapUsed / 1024 / 1024).toFixed(1),
        heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(1),
        rssMB      : (mem.rss / 1024 / 1024).toFixed(1),
      },

      persistence: {
        walSizeBytes : walStats.sizeBytes   || 0,
        walEntries   : walStats.entryCount  || 0,
      },

      expiry: {
        totalSwept : expiryStats.totalSwept || 0,
        sweepCount : expiryStats.sweepCount || 0,
      },

      replication: {
        role       : leaderStats  ? 'leader'
                   : followerStats ? 'follower'
                   : 'standalone',
        leader     : leaderStats,
        follower   : followerStats,
      },
    };
  }

  stop() {
    clearInterval(this._opsTimer);
  }
}

module.exports = StatsCollector;
