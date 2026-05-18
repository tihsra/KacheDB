/**
 * run_tests.js — Comprehensive test suite for mini-redis.
 *
 * Tests every subsystem in isolation (unit tests) and together (integration tests).
 * No external test framework — pure Node.js for zero dependencies.
 *
 * Usage:
 *   node tests/run_tests.js              — run all tests
 *   node tests/run_tests.js --filter store — run tests matching "store"
 *   node tests/run_tests.js --verbose    — show all pass/fail details
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');

const Store            = require('../src/core/Store');
const ExpiryManager    = require('../src/core/ExpiryManager');
const CommandProcessor = require('../src/core/CommandProcessor');
const { RespParser, RespEncoder } = require('../src/protocol/RespParser');
const WAL              = require('../src/persistence/WAL');
const Snapshot         = require('../src/persistence/Snapshot');

// ─── Test Runner ─────────────────────────────────────────────────────────────

const COLORS = {
  green  : '\x1b[32m',
  red    : '\x1b[31m',
  yellow : '\x1b[33m',
  cyan   : '\x1b[36m',
  gray   : '\x1b[90m',
  bold   : '\x1b[1m',
  reset  : '\x1b[0m',
};

const c = (color, str) => COLORS[color] + str + COLORS.reset;

let passed  = 0;
let failed  = 0;
let skipped = 0;
const failures = [];

const filter  = process.argv.includes('--filter')
  ? process.argv[process.argv.indexOf('--filter') + 1]
  : null;
const verbose = process.argv.includes('--verbose');

function test(name, fn) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) {
    skipped++;
    return;
  }

  try {
    fn();
    passed++;
    if (verbose) console.log(c('green', `  ✓ ${name}`));
  } catch (err) {
    failed++;
    failures.push({ name, error: err });
    console.log(c('red', `  ✗ ${name}`));
    if (verbose) console.log(c('gray', `    ${err.message}`));
  }
}

function describe(suiteName, fn) {
  console.log(c('bold', `\n${suiteName}`));
  fn();
}

// ─── Store Tests ─────────────────────────────────────────────────────────────

describe('Store — Core Operations', () => {
  test('SET and GET basic value', () => {
    const store = new Store();
    assert.strictEqual(store.set('key', 'value'), 'OK');
    assert.strictEqual(store.get('key'), 'value');
  });

  test('GET returns null for missing key', () => {
    const store = new Store();
    assert.strictEqual(store.get('nonexistent'), null);
  });

  test('SET overwrites existing value', () => {
    const store = new Store();
    store.set('k', 'first');
    store.set('k', 'second');
    assert.strictEqual(store.get('k'), 'second');
  });

  test('DEL removes a key', () => {
    const store = new Store();
    store.set('k', 'v');
    assert.strictEqual(store.del('k'), 1);
    assert.strictEqual(store.get('k'), null);
  });

  test('DEL returns 0 for missing key', () => {
    const store = new Store();
    assert.strictEqual(store.del('nothing'), 0);
  });

  test('DEL multiple keys', () => {
    const store = new Store();
    store.set('a', '1');
    store.set('b', '2');
    store.set('c', '3');
    assert.strictEqual(store.del('a', 'b', 'z'), 2); // z doesn't exist
    assert.strictEqual(store.get('c'), '3');
  });

  test('EXISTS returns count', () => {
    const store = new Store();
    store.set('a', '1');
    store.set('b', '2');
    assert.strictEqual(store.exists('a', 'b', 'c'), 2);
  });

  test('INCR creates key with value 1', () => {
    const store = new Store();
    assert.strictEqual(store.incr('counter'), 1);
  });

  test('INCR increments existing integer', () => {
    const store = new Store();
    store.set('n', '41');
    assert.strictEqual(store.incr('n'), 42);
  });

  test('INCR returns error for non-integer', () => {
    const store = new Store();
    store.set('s', 'hello');
    const result = store.incr('s');
    assert.ok(result instanceof Error);
  });

  test('DECR decrements', () => {
    const store = new Store();
    store.set('n', '10');
    assert.strictEqual(store.decr('n'), 9);
  });

  test('APPEND concatenates', () => {
    const store = new Store();
    store.set('s', 'hello');
    assert.strictEqual(store.append('s', ' world'), 11);
    assert.strictEqual(store.get('s'), 'hello world');
  });

  test('APPEND creates key if not exists', () => {
    const store = new Store();
    assert.strictEqual(store.append('new', 'data'), 4);
  });

  test('DBSIZE returns correct count', () => {
    const store = new Store();
    store.set('a', '1');
    store.set('b', '2');
    assert.strictEqual(store.dbSize(), 2);
  });

  test('FLUSHALL clears all keys', () => {
    const store = new Store();
    store.set('a', '1');
    store.set('b', '2');
    store.flushAll();
    assert.strictEqual(store.dbSize(), 0);
  });

  test('KEYS returns all keys', () => {
    const store = new Store();
    store.set('user:1', 'Alice');
    store.set('user:2', 'Bob');
    store.set('config', 'x');
    const keys = store.keys('*');
    assert.strictEqual(keys.length, 3);
  });

  test('KEYS with prefix pattern', () => {
    const store = new Store();
    store.set('user:1', 'Alice');
    store.set('user:2', 'Bob');
    store.set('config', 'x');
    const keys = store.keys('user:*');
    assert.strictEqual(keys.length, 2);
  });

  test('toJSON and fromJSON round-trip', () => {
    const store1 = new Store();
    store1.set('name', 'Alice');
    store1.set('age', '30');

    const json = store1.toJSON();

    const store2 = new Store();
    store2.fromJSON(json);

    assert.strictEqual(store2.get('name'), 'Alice');
    assert.strictEqual(store2.get('age'),  '30');
  });
});

// ─── TTL / Expiry Tests ───────────────────────────────────────────────────────

describe('Store — TTL & Expiry', () => {
  test('EXPIRE sets TTL', () => {
    const store = new Store();
    store.set('k', 'v');
    assert.strictEqual(store.expire('k', 60), 1);
  });

  test('EXPIRE returns 0 for missing key', () => {
    const store = new Store();
    assert.strictEqual(store.expire('none', 60), 0);
  });

  test('TTL returns -1 for key without expiry', () => {
    const store = new Store();
    store.set('k', 'v');
    assert.strictEqual(store.ttl('k'), -1);
  });

  test('TTL returns -2 for missing key', () => {
    const store = new Store();
    assert.strictEqual(store.ttl('none'), -2);
  });

  test('TTL returns positive seconds', () => {
    const store = new Store();
    store.set('k', 'v');
    store.expire('k', 100);
    const ttl = store.ttl('k');
    assert.ok(ttl > 95 && ttl <= 100, `Expected TTL ~100, got ${ttl}`);
  });

  test('Expired key returns null on GET (lazy eviction)', (done) => {
    // Note: We test with a very short TTL set manually via timestamp
    const store = new Store();
    store.set('k', 'v');
    // Manually set expiry to 1ms ago
    store._expiry.set('k', Date.now() - 1);
    assert.strictEqual(store.get('k'), null);
  });

  test('PERSIST removes TTL', () => {
    const store = new Store();
    store.set('k', 'v');
    store.expire('k', 100);
    assert.strictEqual(store.persist('k'), 1);
    assert.strictEqual(store.ttl('k'), -1);
  });

  test('SET with EX sets expiry', () => {
    const store = new Store();
    store.set('k', 'v', 60);
    const ttl = store.ttl('k');
    assert.ok(ttl > 55 && ttl <= 60);
  });

  test('SET without EX clears existing expiry', () => {
    const store = new Store();
    store.set('k', 'v', 60);
    store.set('k', 'v2'); // no expiry
    assert.strictEqual(store.ttl('k'), -1);
  });

  test('sweepExpired removes expired keys', () => {
    const store = new Store();
    store.set('a', '1');
    store.set('b', '2');
    // Manually expire key 'a'
    store._expiry.set('a', Date.now() - 1);
    const swept = store.sweepExpired();
    assert.strictEqual(swept, 1);
    assert.strictEqual(store.get('b'), '2');
  });
});

// ─── RESP Parser Tests ────────────────────────────────────────────────────────

describe('RespParser — Protocol Parsing', () => {
  test('Parses simple array command', () => {
    const parser = new RespParser();
    const cmds   = parser.feed('*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n');
    assert.deepStrictEqual(cmds, [['SET', 'foo', 'bar']]);
  });

  test('Parses GET command', () => {
    const parser = new RespParser();
    const cmds   = parser.feed('*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n');
    assert.deepStrictEqual(cmds, [['GET', 'foo']]);
  });

  test('Handles partial reads', () => {
    const parser = new RespParser();
    let cmds = parser.feed('*2\r\n$3\r\n');
    assert.deepStrictEqual(cmds, []); // incomplete
    cmds = parser.feed('GET\r\n$3\r\nfoo\r\n');
    assert.deepStrictEqual(cmds, [['GET', 'foo']]);
  });

  test('Handles pipelined commands', () => {
    const parser = new RespParser();
    const cmds = parser.feed(
      '*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n' +
      '*2\r\n$3\r\nGET\r\n$3\r\nbar\r\n'
    );
    assert.strictEqual(cmds.length, 2);
    assert.deepStrictEqual(cmds[0], ['GET', 'foo']);
    assert.deepStrictEqual(cmds[1], ['GET', 'bar']);
  });

  test('Parses inline command', () => {
    const parser = new RespParser();
    const cmds   = parser.feed('SET foo bar\r\n');
    assert.deepStrictEqual(cmds, [['SET', 'foo', 'bar']]);
  });

  test('Parses inline PING', () => {
    const parser = new RespParser();
    const cmds   = parser.feed('PING\r\n');
    assert.deepStrictEqual(cmds, [['PING']]);
  });

  test('Handles null bulk string ($-1)', () => {
    const parser = new RespParser();
    const cmds   = parser.feed('*2\r\n$3\r\nGET\r\n$-1\r\n');
    assert.deepStrictEqual(cmds, [['GET', null]]);
  });
});

describe('RespEncoder — Response Encoding', () => {
  test('Encodes null as $-1', () => {
    assert.strictEqual(RespEncoder.encode(null), '$-1\r\n');
  });

  test('Encodes integer', () => {
    assert.strictEqual(RespEncoder.encode(42), ':42\r\n');
  });

  test('Encodes string as bulk string', () => {
    assert.strictEqual(RespEncoder.encode('OK'), '$2\r\nOK\r\n');
  });

  test('Encodes Error', () => {
    assert.strictEqual(RespEncoder.encode(new Error('ERR bad')), '-ERR bad\r\n');
  });

  test('Encodes array', () => {
    const result = RespEncoder.encode(['foo', 'bar']);
    assert.strictEqual(result, '*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n');
  });

  test('Encodes empty array', () => {
    assert.strictEqual(RespEncoder.encode([]), '*0\r\n');
  });

  test('Simple string shortcut', () => {
    assert.strictEqual(RespEncoder.simpleString('OK'), '+OK\r\n');
  });
});

// ─── CommandProcessor Tests ───────────────────────────────────────────────────

describe('CommandProcessor — Command Routing', () => {
  function makeProcessor() {
    const store = new Store();
    return { store, proc: new CommandProcessor(store) };
  }

  test('PING returns PONG', () => {
    const { proc } = makeProcessor();
    assert.strictEqual(proc.process(['PING']), 'PONG');
  });

  test('PING with message echoes message', () => {
    const { proc } = makeProcessor();
    assert.strictEqual(proc.process(['PING', 'hello']), 'hello');
  });

  test('ECHO returns message', () => {
    const { proc } = makeProcessor();
    assert.strictEqual(proc.process(['ECHO', 'hello']), 'hello');
  });

  test('SET and GET', () => {
    const { proc } = makeProcessor();
    assert.strictEqual(proc.process(['SET', 'k', 'v']), 'OK');
    assert.strictEqual(proc.process(['GET', 'k']), 'v');
  });

  test('GET missing key returns null', () => {
    const { proc } = makeProcessor();
    assert.strictEqual(proc.process(['GET', 'none']), null);
  });

  test('SET with EX', () => {
    const { proc } = makeProcessor();
    proc.process(['SET', 'k', 'v', 'EX', '100']);
    const ttl = proc.process(['TTL', 'k']);
    assert.ok(ttl > 90 && ttl <= 100);
  });

  test('SET NX — only if not exists', () => {
    const { proc } = makeProcessor();
    proc.process(['SET', 'k', 'original']);
    proc.process(['SET', 'k', 'new', 'NX']); // should be ignored
    assert.strictEqual(proc.process(['GET', 'k']), 'original');
  });

  test('SET XX — only if exists', () => {
    const { proc } = makeProcessor();
    proc.process(['SET', 'k', 'first']);
    proc.process(['SET', 'k', 'second', 'XX']); // should work
    assert.strictEqual(proc.process(['GET', 'k']), 'second');
    proc.process(['SET', 'new_key', 'val', 'XX']); // should be ignored
    assert.strictEqual(proc.process(['GET', 'new_key']), null);
  });

  test('DEL returns delete count', () => {
    const { proc } = makeProcessor();
    proc.process(['SET', 'a', '1']);
    proc.process(['SET', 'b', '2']);
    assert.strictEqual(proc.process(['DEL', 'a', 'b', 'c']), 2);
  });

  test('INCR and DECR', () => {
    const { proc } = makeProcessor();
    assert.strictEqual(proc.process(['INCR', 'n']), 1);
    assert.strictEqual(proc.process(['INCR', 'n']), 2);
    assert.strictEqual(proc.process(['DECR', 'n']), 1);
  });

  test('MSET and MGET', () => {
    const { proc } = makeProcessor();
    proc.process(['MSET', 'a', '1', 'b', '2', 'c', '3']);
    const vals = proc.process(['MGET', 'a', 'b', 'c', 'z']);
    assert.deepStrictEqual(vals, ['1', '2', '3', null]);
  });

  test('DBSIZE', () => {
    const { proc } = makeProcessor();
    proc.process(['SET', 'a', '1']);
    proc.process(['SET', 'b', '2']);
    assert.strictEqual(proc.process(['DBSIZE']), 2);
  });

  test('FLUSHALL', () => {
    const { proc } = makeProcessor();
    proc.process(['SET', 'a', '1']);
    proc.process(['FLUSHALL']);
    assert.strictEqual(proc.process(['DBSIZE']), 0);
  });

  test('Unknown command returns Error', () => {
    const { proc } = makeProcessor();
    const result = proc.process(['BADCMD']);
    assert.ok(result instanceof Error);
  });

  test('Missing args returns Error', () => {
    const { proc } = makeProcessor();
    const result = proc.process(['GET']); // GET requires a key
    assert.ok(result instanceof Error);
  });

  test('WAL callback called on writes', () => {
    const store   = new Store();
    const written = [];
    const proc    = new CommandProcessor(store, null, (args) => written.push(args));
    proc.process(['SET', 'k', 'v']);
    assert.strictEqual(written.length, 1);
    assert.deepStrictEqual(written[0], ['SET', 'k', 'v']);
  });

  test('WAL callback NOT called on reads', () => {
    const store   = new Store();
    const written = [];
    const proc    = new CommandProcessor(store, null, (args) => written.push(args));
    proc.process(['SET', 'k', 'v']);
    proc.process(['GET', 'k']);
    assert.strictEqual(written.length, 1); // only SET, not GET
  });

  test('fromReplication=true skips WAL callback', () => {
    const store   = new Store();
    const written = [];
    const proc    = new CommandProcessor(store, null, (args) => written.push(args));
    proc.process(['SET', 'k', 'v'], true); // fromReplication
    assert.strictEqual(written.length, 0);
    assert.strictEqual(store.get('k'), 'v'); // but store IS updated
  });
});

// ─── WAL Tests ───────────────────────────────────────────────────────────────

describe('WAL — Write-Ahead Log', () => {
  const TEST_WAL = '/tmp/test-wal.log';

  function cleanup() {
    if (fs.existsSync(TEST_WAL)) fs.unlinkSync(TEST_WAL);
  }

  test('Appends and replays entries', () => {
    cleanup();
    const wal = new WAL(TEST_WAL);
    wal.open();
    wal.append(['SET', 'foo', 'bar']);
    wal.append(['SET', 'baz', 'qux']);
    wal.close();

    const wal2   = new WAL(TEST_WAL);
    const entries = wal2.replay();
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries[0], ['SET', 'foo', 'bar']);
    assert.deepStrictEqual(entries[1], ['SET', 'baz', 'qux']);
    cleanup();
  });

  test('currentOffset returns file size', () => {
    cleanup();
    const wal = new WAL(TEST_WAL);
    wal.open();
    wal.append(['SET', 'k', 'v']);
    const offset = wal.currentOffset();
    assert.ok(offset > 0);
    wal.close();
    cleanup();
  });

  test('replay with offset skips earlier entries', () => {
    cleanup();
    const wal = new WAL(TEST_WAL);
    wal.open();
    wal.append(['SET', 'a', '1']);
    const offset = wal.currentOffset(); // offset after first entry
    wal.append(['SET', 'b', '2']);
    wal.close();

    const wal2   = new WAL(TEST_WAL);
    const entries = wal2.replay(offset);
    assert.strictEqual(entries.length, 1);
    assert.deepStrictEqual(entries[0], ['SET', 'b', '2']);
    cleanup();
  });

  test('replay returns empty array if no file', () => {
    cleanup();
    const wal    = new WAL(TEST_WAL);
    const entries = wal.replay();
    assert.deepStrictEqual(entries, []);
  });
});

// ─── Snapshot Tests ───────────────────────────────────────────────────────────

describe('Snapshot — Persistence', () => {
  const TEST_DIR = '/tmp/test-snapshots';

  function cleanup() {
    if (fs.existsSync(TEST_DIR)) {
      fs.readdirSync(TEST_DIR).forEach(f => fs.unlinkSync(path.join(TEST_DIR, f)));
      fs.rmdirSync(TEST_DIR);
    }
  }

  test('Save and load round-trip', () => {
    cleanup();
    const store1 = new Store();
    store1.set('name', 'Alice');
    store1.set('age',  '30');

    const snap1 = new Snapshot(TEST_DIR, store1, null);
    snap1.save();

    const store2 = new Store();
    const snap2  = new Snapshot(TEST_DIR, store2, null);
    snap2.load();

    assert.strictEqual(store2.get('name'), 'Alice');
    assert.strictEqual(store2.get('age'),  '30');
    cleanup();
  });

  test('Load returns 0 with no snapshot', () => {
    cleanup();
    const store  = new Store();
    const snap   = new Snapshot(TEST_DIR, store, null);
    const offset = snap.load();
    assert.strictEqual(offset, 0);
  });

  test('Snapshot preserves expiry timestamps', () => {
    cleanup();
    const store1 = new Store();
    store1.set('k', 'v', 3600); // 1 hour TTL

    const snap1 = new Snapshot(TEST_DIR, store1, null);
    snap1.save();

    const store2 = new Store();
    const snap2  = new Snapshot(TEST_DIR, store2, null);
    snap2.load();

    const ttl = store2.ttl('k');
    assert.ok(ttl > 3500 && ttl <= 3600, `Expected TTL ~3600, got ${ttl}`);
    cleanup();
  });

  test('Old snapshots are pruned', () => {
    cleanup();
    const store = new Store();
    const snap  = new Snapshot(TEST_DIR, store, null);

    // Create 5 snapshots
    for (let i = 0; i < 5; i++) {
      store.set(`key${i}`, String(i));
      snap.save();
    }

    const files = fs.readdirSync(TEST_DIR).filter(f => f.endsWith('.json'));
    assert.ok(files.length <= 3, `Expected at most 3 snapshots, got ${files.length}`);
    cleanup();
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────────

describe('Integration — Full Pipeline', () => {
  test('Full write → snapshot → restore → WAL replay', () => {
    const dir = '/tmp/test-integration';
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
    }

    // Phase 1: write some data
    const store1 = new Store();
    const wal1   = new WAL(`${dir}/wal.log`);
    wal1.open();
    const proc1  = new CommandProcessor(store1, wal1, null);

    proc1.process(['SET', 'user:1', 'Alice']);
    proc1.process(['SET', 'user:2', 'Bob']);

    // Take a snapshot — this also truncates the WAL to zero
    const snap1 = new Snapshot(dir, store1, wal1);
    snap1.save();

    // Write more AFTER snapshot (WAL was truncated, so this starts from offset 0)
    proc1.process(['SET', 'user:3', 'Charlie']);
    wal1.close();

    // Phase 2: simulate restart
    const store2 = new Store();
    const wal2   = new WAL(`${dir}/wal.log`);
    wal2.open();
    const snap2  = new Snapshot(dir, store2, wal2);
    snap2.load(); // loads snapshot (snapshot's walOffset is 0 after truncation)
    const entries = wal2.replay(0); // replay from beginning of (truncated) WAL

    const proc2 = new CommandProcessor(store2, null, null);
    for (const entry of entries) {
      proc2.process(entry, true);
    }
    wal2.close();

    // Verify all data is restored
    assert.strictEqual(store2.get('user:1'), 'Alice');
    assert.strictEqual(store2.get('user:2'), 'Bob');
    assert.strictEqual(store2.get('user:3'), 'Charlie');

    // Cleanup
    fs.readdirSync(dir).forEach(f => fs.unlinkSync(path.join(dir, f)));
    fs.rmdirSync(dir);
  });

  test('RESP parse → CommandProcessor → RESP encode round-trip', () => {
    const store  = new Store();
    const proc   = new CommandProcessor(store, null, null);
    const parser = new RespParser();

    // Simulate a client sending SET foo bar
    const rawCommand = '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n';
    const commands   = parser.feed(rawCommand);
    assert.strictEqual(commands.length, 1);

    const result  = proc.process(commands[0]);
    const encoded = RespEncoder.simpleString(result);
    assert.strictEqual(encoded, '+OK\r\n');

    // Simulate client sending GET foo
    const rawGet  = '*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n';
    const getCmds = parser.feed(rawGet);
    const getResult = proc.process(getCmds[0]);
    const getEncoded = RespEncoder.encode(getResult);
    assert.strictEqual(getEncoded, '$3\r\nbar\r\n');
  });
});

// ─── Results ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(50));
console.log(c('bold', 'Results'));
console.log('─'.repeat(50));
console.log(c('green',  `  Passed:  ${passed}`));
if (failed > 0)  console.log(c('red',    `  Failed:  ${failed}`));
if (skipped > 0) console.log(c('yellow', `  Skipped: ${skipped}`));
console.log('─'.repeat(50));

if (failures.length > 0) {
  console.log(c('red', '\nFailures:'));
  for (const { name, error } of failures) {
    console.log(c('red',  `\n  ✗ ${name}`));
    console.log(c('gray', `    ${error.message}`));
    if (error.actual !== undefined) {
      console.log(c('gray', `    Expected: ${JSON.stringify(error.expected)}`));
      console.log(c('gray', `    Actual:   ${JSON.stringify(error.actual)}`));
    }
  }
  console.log('');
  process.exit(1);
} else {
  console.log(c('green', '\n  All tests passed! ✓\n'));
  process.exit(0);
}
