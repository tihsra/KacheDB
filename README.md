# KacheDB

A Redis-style key-value store written from scratch in Node.js. It speaks the RESP
protocol over raw TCP, persists with a write-ahead log and periodic snapshots, expires
keys with TTLs, and supports leader-follower replication.

```
client (redis-cli / netcat)
   |  RESP over TCP
   v
TCP server -> command processor -> store (Map)
                                      |
                    WAL + snapshots, expiry sweeper, replication
```

## Disclosure

This project's design was informed by studying Redis's own architecture (RESP
protocol, WAL + snapshotting, active/lazy expiry, leader-follower replication). The
core logic — the store, expiry manager, command processor, WAL, snapshotting, and
replication — was implemented as a first pass by hand, then iterated on and refined
with AI assistance for edge cases, error handling, and structure. Inline documentation
(JSDoc) and explanatory comments were generated with AI. The benchmark suite and CLI
client were generated entirely with AI, based on the existing server/protocol code.

## Quick start

```bash
npm install

npm start          # standalone
npm run leader     # leader (opens the replication port)
npm run follower   # follower
npm run cli        # interactive client
npm test
npm run benchmark
```

## Commands

| Command | Syntax | Notes |
|---------|--------|-------|
| `SET` | `SET key value [EX seconds] [NX] [XX]` | value with optional TTL and conditional flags |
| `GET` | `GET key` | null if missing or expired |
| `DEL` | `DEL key [key ...]` | delete one or more keys |
| `EXISTS` | `EXISTS key [key ...]` | count how many exist |
| `EXPIRE` | `EXPIRE key seconds` | set a TTL |
| `TTL` | `TTL key` | remaining TTL (-1 no expiry, -2 missing) |
| `PERSIST` | `PERSIST key` | remove the TTL |
| `INCR` / `DECR` | `INCR key` | increment / decrement an integer |
| `APPEND` | `APPEND key value` | append to a string |
| `MSET` / `MGET` | `MSET k1 v1 ...` | multi set / get |
| `KEYS` | `KEYS [pattern]` | keys matching a glob |
| `DBSIZE` | `DBSIZE` | number of keys |
| `FLUSHALL` | `FLUSHALL` | delete everything |
| `PING` / `ECHO` / `INFO` | | heartbeat / echo / server stats |

## How it works

**TCP server (`src/server/Server.js`)** is built on the `net` module - raw TCP, not
HTTP. Node's single event loop handles many connections on one thread, so no two
command handlers run at the same time and the store needs no locking. Each connection
gets its own `RespParser` for buffering.

**RESP protocol (`src/protocol/RespParser.js`)** is the same wire format Redis uses, so
a normal `redis-cli` can connect. Because TCP is a stream, one client write does not map
to one server `data` event, so the parser buffers incoming bytes and only emits a
command once it is complete. It also handles pipelining (several commands in one packet,
parsed and answered together) and inline space-separated commands.

**Store (`src/core/Store.js`)** is a `Map` plus a parallel map of expiry timestamps.
Operations are O(1) on average.

**Expiry (`src/core/ExpiryManager.js`)** uses two strategies together, the same way
Redis does. Lazy: every read checks expiry and drops the key if it is stale. Active: a
sweep every 100ms removes expired keys that nobody reads. Lazy alone would leak memory
for write-only keys; active alone would be wasteful if run too often.

**Write-ahead log (`src/persistence/WAL.js`)** is an append-only file, one JSON array
per line. It is fsync'd once a second (the "everysec" mode, Redis's default trade-off
between speed and durability). After a snapshot the log is truncated, since the snapshot
already captures those writes.

**Snapshots (`src/persistence/Snapshot.js`)** dump the whole store to JSON every five
minutes. The data is written to a temp file and then renamed into place, which is atomic
on POSIX, so a crash mid-write cannot leave a corrupt snapshot. The last three snapshots
are kept. On restart the server loads the newest snapshot and replays only the WAL
entries written after it.

**Replication (`src/replication/Replication.js`)** is leader-follower and asynchronous.
A follower connects to the leader's replication port, receives a full snapshot, then
gets every subsequent write streamed to it in real time. Followers are read-only and
reject writes with `READONLY`. The leader acknowledges the client before followers apply
the write, so a follower can lag by a few milliseconds; if the leader crashes the last
few writes can be lost. A reconnecting follower does a full resync.

## Actual unfixed Issues 

**Issue with Date.now():** Suppose we had a key that had to expire 30 seconds from now,
`while setting the key the leader died` and hence we had to replay the WAL entry but this
entry would say TTL to be 30 seconds. Even though some time would probably had passed. 
Fix could be saving the current time and setting the ttl relative to that.   

**CommandProcessor.js inconsistency**
The below code is inconsistent 
```
if (!(result instanceof Error) && this._writeCommands.has(name) && !fromReplication) {
  if (this._wal) this._wal.append(args);
  if (this._onWrite) this._onWrite(args);
}
```
Unable to process failed status other than errors
For example: If  for `NX` flag in `SET` command the key exists this return `null`
but this code would append this to `wal` and braodcast to followers.
This could be prevented to save BW.

## CLI

```bash
node cli/client.js
node cli/client.js --port 6380     # connect to a follower

127.0.0.1:6379> SET user:1 Alice
OK
127.0.0.1:6379> SET session:abc token123 EX 3600
OK
127.0.0.1:6379> TTL session:abc
(integer) 3600
127.0.0.1:6379> INCR counter
(integer) 1
```

## Replication setup

```bash
# leader
node src/server/Server.js --port 6379 --role leader --repl-port 7379

# follower
node src/server/Server.js --port 6380 --role follower --leader-port 6379

# write to the leader, read from the follower
node cli/client.js --port 6379
127.0.0.1:6379> SET foo bar
OK
node cli/client.js --port 6380
127.0.0.1:6380> GET foo
"bar"
127.0.0.1:6380> SET x 1
(error) READONLY You can't write against a read only replica
```

## Tests

```bash
node tests/run_tests.js              # all tests
node tests/run_tests.js --verbose    # show each test name
node tests/run_tests.js --filter wal # tests matching "wal"
```

70 tests across the store, TTL/expiry, the RESP parser and encoder, the command
processor (including NX/XX flags and the WAL/replication callbacks), the WAL, snapshots,
and a couple of end-to-end pipeline tests (write -> snapshot -> restart -> WAL replay,
and RESP parse -> process -> RESP encode).

## Benchmarks

```bash
node benchmarks/run_benchmark.js
node benchmarks/run_benchmark.js --ops 500000
```

The benchmark covers the in-memory store, the RESP parser, the full pipeline, and a
networked round-trip. The in-memory paths are fast; the networked number is dominated by
TCP round-trip latency even on localhost. Run it to see the numbers on your machine.

## Layout

```
src/
  server/
    Server.js          wires the subsystems together, startup/shutdown
    ClientHandler.js   one per connection: read, dispatch, write
  core/
    Store.js           Map with TTL tracking
    ExpiryManager.js   active sweep every 100ms
    CommandProcessor.js routes parsed commands to the store
  protocol/
    RespParser.js      RESP parser + encoder
  persistence/
    WAL.js             append-only log, fsync every second
    Snapshot.js        full dump, atomic write, 5 min interval, last 3 kept
  replication/
    Replication.js     leader (streams writes) + follower (applies them)
  stats/
    StatsCollector.js  metrics
cli/client.js          interactive client
tests/run_tests.js     70 tests across all subsystems
benchmarks/run_benchmark.js
```


## Known limitations

| Limitation | Where it would go in production |
|-----------|---------------------------------|
| Single leader, no automatic failover | Sentinel or a Raft-based election |
| Full resync on reconnect | a replication backlog for partial resync |
| No authentication | an `AUTH` command |
| JSON WAL/snapshot (verbose) | a binary encoding |
| No pub/sub, scripting, or multiple databases | `SUBSCRIBE`/`PUBLISH`, `EVAL`, `SELECT` |
