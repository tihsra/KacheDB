# mini-redis

A distributed key-value store built from scratch in Node.js — persistent, replicated, and production-inspired.

```
Client (CLI / netcat)
      │  RESP protocol over raw TCP
      ▼
┌─────────────┐    ┌──────────────────┐    ┌──────────────┐
│  TCP Server │───▶│ CommandProcessor │───▶│    Store     │
│  (net module│    │  (dispatcher)    │    │  (HashMap)   │
└─────────────┘    └──────────────────┘    └──────┬───────┘
                          │                        │
                   ┌──────▼──────┐         ┌───────▼──────┐
                   │     WAL     │         │   Expiry     │
                   │ (wal.log)   │         │   Manager    │
                   └──────┬──────┘         └──────────────┘
                          │
                   ┌──────▼──────┐    ┌──────────────────┐
                   │  Snapshot   │    │   Replication    │
                   │  (*.json)   │    │  Leader/Follower │
                   └─────────────┘    └──────────────────┘
```

---

## Quick Start

```bash
# Install dependencies
npm install

# Start the server (standalone mode)
npm start

# Or: start as leader (enables replication port)
npm run leader

# In another terminal: connect with the CLI
npm run cli

# Start a follower (in a third terminal)
npm run follower

# Run the test suite
npm test

# Run benchmarks
npm run benchmark
```

---

## What This Is

A Redis-inspired key-value store that implements the core ideas behind production distributed databases:

- **In-memory storage** — O(1) GET/SET using a JavaScript Map
- **RESP wire protocol** — same protocol real Redis uses, over raw TCP sockets
- **Write-Ahead Log** — every write is logged to disk before being applied
- **Snapshots** — periodic full-store dump for fast restarts
- **Expiry system** — TTL with both lazy and active eviction
- **Leader-follower replication** — stream WAL entries to connected followers
- **React dashboard** — live stats over WebSocket

---

## Supported Commands

| Command | Syntax | Description |
|---------|--------|-------------|
| `SET` | `SET key value [EX seconds] [NX] [XX]` | Set a value with optional TTL and conditional flags |
| `GET` | `GET key` | Get a value (null if missing or expired) |
| `DEL` | `DEL key [key ...]` | Delete one or more keys |
| `EXISTS` | `EXISTS key [key ...]` | Count how many of the given keys exist |
| `EXPIRE` | `EXPIRE key seconds` | Set TTL on an existing key |
| `TTL` | `TTL key` | Get remaining TTL (-1 = no expiry, -2 = missing) |
| `PERSIST` | `PERSIST key` | Remove TTL from a key |
| `INCR` | `INCR key` | Atomically increment integer value |
| `DECR` | `DECR key` | Atomically decrement integer value |
| `APPEND` | `APPEND key value` | Append to string value |
| `MSET` | `MSET k1 v1 k2 v2 ...` | Set multiple keys atomically |
| `MGET` | `MGET k1 k2 ...` | Get multiple values |
| `KEYS` | `KEYS [pattern]` | List keys matching glob pattern |
| `DBSIZE` | `DBSIZE` | Total number of keys |
| `FLUSHALL` | `FLUSHALL` | Delete all keys |
| `PING` | `PING [message]` | Heartbeat |
| `ECHO` | `ECHO message` | Echo back a message |
| `INFO` | `INFO` | Server stats |

---

## Architecture Deep Dive

### Stage 1 — TCP Server (`src/server/Server.js`)

Built on Node's `net` module — raw TCP, not HTTP. The event loop handles thousands of concurrent connections in a single thread. Each connection gets its own `ClientHandler` which owns a `RespParser` instance (for partial read buffering).

**Why not HTTP?**
HTTP adds ~200–500 bytes of header overhead per request. For a KV store doing 100k ops/sec, that's 20–50MB/s of wasted bandwidth just in headers. RESP is minimal — a SET command is ~20 bytes.

**Why single-threaded event loop instead of threads?**
The event loop eliminates lock contention entirely — no two handlers ever run simultaneously, so the Store needs no locks. Node.js is single-threaded, so `Map.get()` and `Map.set()` are inherently atomic. A thread-per-connection model would require `ConcurrentHashMap`-style locking.

### Stage 2 — RESP Protocol (`src/protocol/RespParser.js`)

Redis Serialization Protocol — the same wire format real Redis clients use. This means you can connect to mini-redis with any standard `redis-cli` or any Redis client library.

**The partial read problem:** TCP is a stream. One `socket.write()` on the client does not guarantee one `data` event on the server. The parser buffers incoming bytes and only emits a command when it's confirmed complete. This is the main source of bugs in naive TCP servers.

**Pipelining:** A client can send multiple commands without waiting for responses. One `data` event may contain several complete commands. The parser returns all of them; `ClientHandler` processes each and sends all responses in one `socket.write()`.

### Stage 3 — Store (`src/core/Store.js`)

A JavaScript `Map` wrapped with expiry tracking. All operations are O(1) average. The expiry system uses a parallel `Map<key, timestampMs>`.

**Lazy vs active eviction:**
- Lazy: every read checks expiry before returning. Expired keys are cleaned up on access.
- Active: `ExpiryManager` runs a sweep every 100ms and deletes expired keys proactively.
- Why both? Lazy alone allows unbounded memory growth for keys that are written but never read. Active alone is expensive if run too frequently on large keyspaces.

### Stage 4 — Write-Ahead Log (`src/persistence/WAL.js`)

An append-only file. Every write command is serialized to JSON and appended **before** the store is updated. On crash:

1. Load latest snapshot
2. Replay WAL entries written after the snapshot timestamp
3. Store is restored to exact pre-crash state

**Why append-only?** Appending is the fastest possible disk write — sequential, no seeking. The OS page cache buffers writes; we `fsync()` every second ("everysec" durability mode — same default as Redis).

**WAL truncation:** After each snapshot, the WAL is truncated to zero. Pre-snapshot entries are now redundant — the snapshot already contains their effect.

### Stage 5 — Snapshot (`src/persistence/Snapshot.js`)

Every 5 minutes (configurable), the full store is serialized to JSON and written atomically:

1. Serialize store → temp file (`snapshot-<ts>.json.tmp`)
2. `rename()` temp → final (atomic on POSIX — readers always see a complete file)
3. Truncate WAL

**Atomicity matters:** If we wrote directly to the final file and crashed mid-write, we'd have a corrupt snapshot. The rename-from-temp pattern guarantees the file is always either the old complete version or the new complete version.

### Stage 6 — Replication (`src/replication/Replication.js`)

Leader-follower async replication:

1. Follower connects to leader's replication port
2. Leader sends a full snapshot immediately
3. Follower loads snapshot, sends `ready`
4. Leader streams every subsequent write command in real time
5. Follower applies commands to its local store (bypassing its own WAL)

**Async vs sync replication:**
This implementation is asynchronous — the leader returns `OK` to the client before followers acknowledge. This means followers can lag by milliseconds. If the leader crashes, the last few writes may be lost. Synchronous replication (waiting for one follower to ACK before returning OK) eliminates this risk but adds latency.

**Reconnection:** If a follower disconnects, it reconnects after 5 seconds and receives a full snapshot again (full resync). A production system would implement partial resync using the replication offset.

---

## CLI Usage

```bash
# Basic usage
node cli/client.js

# Connect to a different port (e.g. a follower)
node cli/client.js --port 6380

# Example session
127.0.0.1:6379> SET user:1 Alice
OK
127.0.0.1:6379> SET session:abc token123 EX 3600
OK
127.0.0.1:6379> TTL session:abc
(integer) 3600
127.0.0.1:6379> MSET counter 0 name "mini-redis"
OK
127.0.0.1:6379> INCR counter
(integer) 1
127.0.0.1:6379> KEYS user:*
1) "user:1"
127.0.0.1:6379> INFO
# Server
uptime_in_seconds:42
...
```

---

## Replication Setup

```bash
# Terminal 1 — start leader
node src/server/Server.js --port 6379 --role leader --repl-port 7379

# Terminal 2 — start follower
node src/server/Server.js --port 6380 --role follower --leader-port 6379

# Terminal 3 — write to leader
node cli/client.js --port 6379
127.0.0.1:6379> SET foo bar
OK

# Terminal 4 — read from follower (data is replicated)
node cli/client.js --port 6380
127.0.0.1:6380> GET foo
"bar"

# Followers are read-only
127.0.0.1:6380> SET x 1
(error) READONLY You can't write against a read only replica
```

---

## Running Tests

```bash
node tests/run_tests.js              # all tests
node tests/run_tests.js --verbose    # show each test name
node tests/run_tests.js --filter wal # run tests matching "wal"
```

**Test coverage:**
- Store: SET, GET, DEL, EXISTS, INCR, DECR, APPEND, MSET, KEYS, FLUSHALL, DBSIZE
- TTL: EXPIRE, TTL, PERSIST, lazy expiry, active sweep, SET EX
- RESP Parser: arrays, inline commands, partial reads, pipelining, null bulk strings
- RESP Encoder: all types
- CommandProcessor: all commands, NX/XX flags, error handling, WAL callback, replication bypass
- WAL: append, replay, offset-based replay, empty file
- Snapshot: save/load round-trip, expiry preservation, old snapshot pruning
- Integration: full write → snapshot → restart → WAL replay pipeline

---

## Benchmarks

```bash
node benchmarks/run_benchmark.js          # standard run (100k ops)
node benchmarks/run_benchmark.js --ops 500000  # more ops
```

**Typical results:**

| Benchmark | Throughput | p50 latency |
|-----------|-----------|-------------|
| Store SET | ~8M ops/s | ~120ns |
| Store GET (hit) | ~10M ops/s | ~100ns |
| RESP parse SET | ~1.5M ops/s | ~650ns |
| Full pipeline SET | ~900K ops/s | ~1.1µs |
| TCP SET (network) | ~25K ops/s | ~40µs |

The network benchmark dominates — TCP round-trip latency is ~40µs even on localhost. This is inherent to the kernel's TCP stack. Production Redis achieves ~100K ops/s on localhost because it batches more aggressively (kernel bypass techniques like io_uring or DPDK can push this further).

---

## React Dashboard

```bash
cd dashboard && npm install && npm start
```

Open `http://localhost:3000` — connects to the server's WebSocket port (8379) automatically.

**Features:**
- Live ops/sec with sparkline
- Total key count with sparkline
- Hit rate with colour coding
- Memory usage bar
- WAL stats (entries, size on disk)
- Expiry sweeper stats
- Replication panel (follower list, lag, offsets)
- Activity log (commands per second)

---

## Project Structure

```
mini-redis/
├── src/
│   ├── server/
│   │   ├── Server.js           Entry point — wires all subsystems, handles startup/shutdown
│   │   └── ClientHandler.js    One instance per TCP connection — reads, dispatches, writes
│   ├── core/
│   │   ├── Store.js            HashMap with TTL — all key-value operations
│   │   ├── ExpiryManager.js    Background sweeper — active TTL eviction every 100ms
│   │   └── CommandProcessor.js Dispatcher — routes parsed commands to Store methods
│   ├── protocol/
│   │   └── RespParser.js       RESP parser + encoder — wire protocol implementation
│   ├── persistence/
│   │   ├── WAL.js              Write-ahead log — append-only, fsync every second
│   │   └── Snapshot.js         Full store dump — atomic write, 5min interval, 3 kept
│   ├── replication/
│   │   └── Replication.js      Leader (streams WAL) + Follower (applies commands)
│   └── stats/
│       └── StatsCollector.js   Aggregates metrics for the WebSocket dashboard
├── cli/
│   └── client.js               Interactive terminal client (like redis-cli)
├── dashboard/
│   └── src/
│       └── Dashboard.jsx        React live stats dashboard
├── tests/
│   └── run_tests.js             60+ tests across all subsystems
├── benchmarks/
│   └── run_benchmark.js         Store, RESP, pipeline, and network benchmarks
└── README.md
```

---

## Design Decisions

**Why Node.js instead of Java/Go?**
Node's event loop is a perfect fit for a high-concurrency IO server — one thread handles thousands of clients without lock overhead. The event loop model is itself a key concept in system design interviews. Java would require `ConcurrentHashMap` and thread pool management for equivalent concurrency.

**Why JSON for WAL/Snapshot instead of binary?**
Human-readable. You can `cat data/wal.log` and see exactly what was written. Redis uses binary RDB/AOF formats for compactness — a production enhancement worth discussing in interviews.

**Why async replication?**
Same tradeoff Redis makes by default: lower write latency in exchange for potential data loss of milliseconds on leader crash. Synchronous replication (wait for follower ACK) is the PostgreSQL `synchronous_commit` model — safer but slower.

**Why full resync on follower reconnect?**
Simplicity. A production system uses the replication offset to do partial resync — only send commands the follower missed. Implementing a circular buffer of recent commands (Redis's replication backlog) is a worthwhile extension.

---

## Known Limitations

| Limitation | Production Solution |
|-----------|---------------------|
| Single-leader, no automatic failover | Sentinel or Raft consensus for leader election |
| Full resync on reconnect | Replication backlog for partial resync |
| No authentication | `AUTH` command + password hashing |
| JSON WAL/Snapshot (verbose) | Binary encoding (msgpack / protobuf) |
| No pub/sub | SUBSCRIBE / PUBLISH command set |
| No Lua scripting | EVAL command |
| Single database | Multi-DB with SELECT command |

---

*Built as a portfolio systems project. Full implementation — not a tutorial wrapper.*
