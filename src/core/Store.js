/**
 * Store.js — the key-value store. A Map holds the data, with a parallel Map of
 * expiry timestamps; get/set/delete are O(1) on average. A Map is used over a
 * plain object to keep insertion order (for KEYS), avoid prototype-key issues,
 * and get O(1) size. No locks are needed since handlers run single-threaded.
 */

class Store {
  constructor() {
    // Primary key→value store
    this._data = new Map();

    // key → absolute expiry timestamp in milliseconds
    // If a key has no entry here it never expires
    this._expiry = new Map();

    // Counters for the stats dashboard
    this._hits   = 0;
    this._misses = 0;
    this._totalCommands = 0;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Lazy expiry check.
   * Called on every read. If the key has expired we delete it now and
   * pretend it never existed — this is exactly how Redis does it.
   * Returns true if the key is expired (and has been cleaned up).
   */
  _isExpired(key) {
    if (!this._expiry.has(key)) return false;
    const expiresAt = this._expiry.get(key);
    if (Date.now() >= expiresAt) {
      // Key has expired — delete from both maps
      this._data.delete(key);
      this._expiry.delete(key);
      return true;
    }
    return false;
  }

  // ─── Core Commands ───────────────────────────────────────────────────────────

  /**
   * SET key value [EX seconds]
   * Stores a value. Optionally sets a TTL in seconds.
   * Returns "OK".
   *
   * LEARNING POINT: In Redis, SET with EX is atomic — it sets the value
   * AND the expiry in one operation. We replicate that here.
   */
  set(key, value, expirySeconds = null) {
    this._totalCommands++;
    this._data.set(key, value);

    if (expirySeconds !== null) {
      // Convert relative seconds → absolute millisecond timestamp
      this._expiry.set(key, Date.now() + expirySeconds * 1000);
    } else {
      // If no expiry specified, clear any existing expiry for this key
      // (SET on an existing key with TTL should reset it to no expiry)
      this._expiry.delete(key);
    }

    return 'OK';
  }

  /**
   * GET key
   * Returns the value or null (Redis returns nil for missing keys).
   *
   * LEARNING POINT: We check expiry BEFORE returning. This is lazy eviction.
   * The key may have expired but not been cleaned up by the active sweeper yet.
   * We catch it here so the caller never sees a stale value.
   */
  get(key) {
    this._totalCommands++;

    // Lazy expiry — if expired, _isExpired deletes it and returns true
    if (this._isExpired(key)) {
      this._misses++;
      return null;
    }

    if (!this._data.has(key)) {
      this._misses++;
      return null;
    }

    this._hits++;
    return this._data.get(key);
  }

  /**
   * DEL key [key ...]
   * Deletes one or more keys. Returns count of keys actually deleted.
   */
  del(...keys) {
    this._totalCommands++;
    let deleted = 0;
    for (const key of keys) {
      if (this._data.has(key) && !this._isExpired(key)) {
        this._data.delete(key);
        this._expiry.delete(key);
        deleted++;
      }
    }
    return deleted;
  }

  /**
   * EXISTS key [key ...]
   * Returns count of keys that exist (expired keys count as non-existent).
   */
  exists(...keys) {
    this._totalCommands++;
    let count = 0;
    for (const key of keys) {
      if (!this._isExpired(key) && this._data.has(key)) {
        count++;
      }
    }
    return count;
  }

  /**
   * EXPIRE key seconds
   * Sets a TTL on an existing key.
   * Returns 1 if the key exists and TTL was set, 0 if key doesn't exist.
   *
   * LEARNING POINT: EXPIRE only works on keys that already exist.
   * You cannot pre-expire a key that hasn't been SET yet.
   */
  expire(key, seconds) {
    this._totalCommands++;
    if (this._isExpired(key) || !this._data.has(key)) return 0;
    this._expiry.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  /**
   * TTL key
   * Returns remaining time to live in seconds.
   * -1 = key exists but has no expiry
   * -2 = key does not exist (or has expired)
   *
   * LEARNING POINT: This mirrors Redis TTL semantics exactly.
   * -1 and -2 are sentinel values, not errors.
   */
  ttl(key) {
    this._totalCommands++;
    if (this._isExpired(key) || !this._data.has(key)) return -2;
    if (!this._expiry.has(key)) return -1;
    const remaining = Math.ceil((this._expiry.get(key) - Date.now()) / 1000);
    return Math.max(0, remaining);
  }

  /**
   * PERSIST key
   * Removes the TTL from a key, making it persist indefinitely.
   * Returns 1 if TTL was removed, 0 if key had no TTL or doesn't exist.
   */
  persist(key) {
    this._totalCommands++;
    if (this._isExpired(key) || !this._data.has(key)) return 0;
    if (!this._expiry.has(key)) return 0;
    this._expiry.delete(key);
    return 1;
  }

  /**
   * INCR key
   * Atomically increments integer value by 1.
   * Creates the key with value 0 first if it doesn't exist.
   * Returns new value, or error string if value is not an integer.
   *
   * LEARNING POINT: INCR is atomic in Redis because Redis is single-threaded.
   * We get the same guarantee from Node's event loop.
   */
  incr(key) {
    this._totalCommands++;
    if (this._isExpired(key)) this._data.delete(key);

    const current = this._data.has(key) ? this._data.get(key) : '0';
    const num = parseInt(current, 10);
    if (isNaN(num)) return new Error('ERR value is not an integer');

    const newVal = String(num + 1);
    this._data.set(key, newVal);
    return num + 1;
  }

  /**
   * DECR key
   * Atomically decrements integer value by 1.
   */
  decr(key) {
    this._totalCommands++;
    if (this._isExpired(key)) this._data.delete(key);

    const current = this._data.has(key) ? this._data.get(key) : '0';
    const num = parseInt(current, 10);
    if (isNaN(num)) return new Error('ERR value is not an integer');

    const newVal = String(num - 1);
    this._data.set(key, newVal);
    return num - 1;
  }

  /**
   * APPEND key value
   * Appends a string to the existing value. Creates key if not exists.
   * Returns new length of the string.
   */
  append(key, value) {
    this._totalCommands++;
    if (this._isExpired(key)) this._data.delete(key);
    const current = this._data.has(key) ? this._data.get(key) : '';
    const newVal = current + value;
    this._data.set(key, newVal);
    return newVal.length;
  }

  /**
   * KEYS pattern
   * Returns all keys matching a glob-style pattern.
   * Supports * (any chars), ? (single char), [abc] (character class).
   *
   * LEARNING POINT: In production Redis, KEYS is O(n) and blocks the server.
   * It's fine for debugging but dangerous on large datasets. Production uses SCAN.
   */
  keys(pattern = '*') {
    this._totalCommands++;
    const regex = this._globToRegex(pattern);
    const result = [];
    for (const key of this._data.keys()) {
      if (!this._isExpired(key) && regex.test(key)) {
        result.push(key);
      }
    }
    return result;
  }

  /**
   * FLUSHALL
   * Deletes every key. Returns "OK".
   */
  flushAll() {
    this._totalCommands++;
    this._data.clear();
    this._expiry.clear();
    return 'OK';
  }

  /**
   * DBSIZE
   * Returns total number of keys (excluding expired ones).
   */
  dbSize() {
    // We can't just return _data.size because some keys may be lazily un-expired
    // Clean up first, then count
    for (const key of [...this._data.keys()]) {
      this._isExpired(key); // side-effect: removes expired keys
    }
    return this._data.size;
  }

  // ─── Bulk Export / Import (for WAL replay and snapshots) ──────────────────

  /**
   * Returns a plain object representation of the entire store.
   * Used by the Snapshot module to dump state to disk.
   */
  toJSON() {
    const data    = {};
    const expiry  = {};

    for (const [key, val] of this._data.entries()) {
      if (!this._isExpired(key)) {
        data[key]   = val;
        if (this._expiry.has(key)) {
          expiry[key] = this._expiry.get(key);
        }
      }
    }

    return { data, expiry };
  }

  /**
   * Restores store from a plain object (loaded from snapshot).
   * Clears existing state first.
   */
    fromJSON({data, expiry}){

        this._data.clear();
        this._expiry.clear();

        for(const [key,value] of Object.entries(data)){

            if(expiry[key]===undefined || expiry[key]>Date.now()){
                this._data.set(key,value);
                if(expiry[key]!==undefined) this._expiry.set(key,expiry[key]);
            }
           
        }

    }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  getStats() {
    return {
      keyCount      : this.dbSize(),
      hits          : this._hits,
      misses        : this._misses,
      totalCommands : this._totalCommands,
      hitRate       : this._hits + this._misses === 0
                        ? 0
                        : ((this._hits / (this._hits + this._misses)) * 100).toFixed(1),
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Converts a Redis glob pattern to a JavaScript RegExp.
   *   *   → .*
   *   ?   → .
   *   [abc] → [abc]  (passed through)
   *   Everything else is escaped.
   */
  _globToRegex(pattern) {
    const escaped = pattern
      .replace(/[.+^${}()|\\]/g, '\\$&')  // escape regex special chars { our redis we have only two search pattern * and ?  
      .replace(/\*/g, '.*')                // * → any chars { in regex it should be .* meaning match any character any number of thims }
      .replace(/\?/g, '.');               // ? → single char { in regex it should be .? meaning match any character any number of thims }
    return new RegExp(`^${escaped}$`);
  }

  // Active expiry — called by ExpiryManager on a timer
  sweepExpired() {
    let swept = 0;
    for (const key of [...this._expiry.keys()]) {
      if (this._isExpired(key)) swept++;
    }
    return swept;
  }
}

module.exports = Store;
