/**
 * run_benchmark.js — Throughput and latency benchmarks for mini-redis.
 *
 * Benchmarks the core pipeline in isolation (no network overhead)
 * and with a real TCP connection.
 *
 * Usage:
 *   node benchmarks/run_benchmark.js              — all benchmarks
 *   node benchmarks/run_benchmark.js --ops 10000  — custom op count
 *
 * WHAT WE MEASURE:
 *   1. Store throughput      — raw HashMap ops/sec
 *   2. RESP parse throughput — parser ops/sec
 *   3. Command pipeline      — parse + execute + encode ops/sec
 *   4. Network throughput    — full TCP round-trip ops/sec
 *
 * HOW TO READ THE RESULTS:
 *   ops/sec     = how many operations per second
 *   p50 latency = median latency (50% of ops faster than this)
 *   p99 latency = tail latency (99% of ops faster than this)
 *
 *   Store should be millions of ops/sec (it's just a HashMap).
 *   Network will be thousands-tens of thousands ops/sec (TCP overhead).
 */

'use strict';

const net = require('net');
const { RespParser, RespEncoder } = require('../src/protocol/RespParser');
const Store            = require('../src/core/Store');
const CommandProcessor = require('../src/core/CommandProcessor');

const args    = process.argv.slice(2);
const OPS     = parseInt(args[args.indexOf('--ops') + 1]) || 100_000;
const NET_OPS = 10_000; // fewer for network benchmark (TCP is slow)

const COLORS = {
  green : '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  bold  : '\x1b[1m',  reset : '\x1b[0m',  gray: '\x1b[90m',
};
const c = (color, str) => COLORS[color] + str + COLORS.reset;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bench(name, fn, ops) {
  // Warmup
  for (let i = 0; i < Math.min(1000, ops / 10); i++) fn(i);

  const latencies = [];
  const start     = process.hrtime.bigint();

  for (let i = 0; i < ops; i++) {
    const t0 = process.hrtime.bigint();
    fn(i);
    latencies.push(Number(process.hrtime.bigint() - t0));
  }

  const elapsed   = Number(process.hrtime.bigint() - start) / 1e9; // seconds
  const opsPerSec = Math.round(ops / elapsed);

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(ops * 0.50)];
  const p99 = latencies[Math.floor(ops * 0.99)];

  return { name, ops, opsPerSec, elapsed, p50, p99 };
}

function formatResult(r) {
  const opsStr   = r.opsPerSec.toLocaleString().padStart(12);
  const p50Str   = formatNs(r.p50).padStart(10);
  const p99Str   = formatNs(r.p99).padStart(10);
  console.log(
    c('cyan',   `  ${r.name.padEnd(35)}`) +
    c('green',  `${opsStr} ops/s`) +
    c('gray',   `  p50=${p50Str}  p99=${p99Str}`)
  );
}

function formatNs(ns) {
  if (ns < 1_000)       return `${ns}ns`;
  if (ns < 1_000_000)   return `${(ns / 1000).toFixed(1)}µs`;
  return `${(ns / 1_000_000).toFixed(1)}ms`;
}

function printHeader(title) {
  console.log('\n' + c('bold', title));
  console.log('─'.repeat(75));
  console.log(
    c('gray', '  ' + 'Benchmark'.padEnd(35) + 'Throughput'.padStart(12) +
    '  p50 latency  p99 latency')
  );
  console.log('─'.repeat(75));
}

// ─── 1. Store Benchmarks ──────────────────────────────────────────────────────

async function benchStore() {
  printHeader('1. Store — Raw HashMap Performance');

  const store = new Store();

  // Pre-populate for GET benchmarks
  for (let i = 0; i < 1000; i++) store.set(`key:${i}`, `value:${i}`);

  formatResult(bench('SET (new key)',       (i) => store.set(`bench:${i}`, 'value'), OPS));
  formatResult(bench('SET (overwrite)',     (i) => store.set('same_key', `v${i}`),  OPS));
  formatResult(bench('GET (hit)',           (i) => store.get(`key:${i % 1000}`),    OPS));
  formatResult(bench('GET (miss)',          (i) => store.get(`missing:${i}`),       OPS));
  formatResult(bench('INCR',               (i) => store.incr('counter'),           OPS));
  formatResult(bench('EXISTS',             (i) => store.exists(`key:${i % 1000}`), OPS));
  formatResult(bench('DEL (exists)',        (i) => {
    store.set('del_key', 'v');
    store.del('del_key');
  }, OPS));
}

// ─── 2. RESP Parser Benchmarks ────────────────────────────────────────────────

async function benchResp() {
  printHeader('2. RESP Parser — Protocol Performance');

  const setCmd = '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n';
  const getCmd = '*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n';
  const pipelined = setCmd.repeat(10); // 10 commands in one chunk

  formatResult(bench('Parse SET (RESP array)',    () => { const p = new RespParser(); p.feed(setCmd); }, OPS));
  formatResult(bench('Parse GET (RESP array)',    () => { const p = new RespParser(); p.feed(getCmd); }, OPS));
  formatResult(bench('Parse inline "GET foo"',   () => { const p = new RespParser(); p.feed('GET foo\r\n'); }, OPS));
  formatResult(bench('Parse 10 pipelined cmds',  () => { const p = new RespParser(); p.feed(pipelined); }, OPS / 10));
  formatResult(bench('Encode null ($-1)',         () => RespEncoder.encode(null),    OPS));
  formatResult(bench('Encode integer (:42)',      () => RespEncoder.encode(42),      OPS));
  formatResult(bench('Encode bulk string ($6)',   () => RespEncoder.encode('foobar'), OPS));
  formatResult(bench('Encode array (*3)',         () => RespEncoder.encode(['a','b','c']), OPS));
}

// ─── 3. Full Pipeline Benchmarks ─────────────────────────────────────────────

async function benchPipeline() {
  printHeader('3. Full Pipeline — Parse → Execute → Encode');

  const store = new Store();
  const proc  = new CommandProcessor(store, null, null);

  const setCmd = '*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n';
  const getCmd = '*2\r\n$3\r\nGET\r\n$3\r\nfoo\r\n';

  proc.process(['SET', 'foo', 'bar']); // pre-populate

  formatResult(bench('SET full pipeline', () => {
    const parser = new RespParser();
    const cmds   = parser.feed(setCmd);
    const result = proc.process(cmds[0]);
    RespEncoder.simpleString(result);
  }, OPS));

  formatResult(bench('GET full pipeline', () => {
    const parser = new RespParser();
    const cmds   = parser.feed(getCmd);
    const result = proc.process(cmds[0]);
    RespEncoder.encode(result);
  }, OPS));

  formatResult(bench('INCR full pipeline', () => {
    const cmds = [['INCR', 'counter']];
    const result = proc.process(cmds[0]);
    RespEncoder.encode(result);
  }, OPS));
}

// ─── 4. Network Benchmarks (requires server running) ─────────────────────────

async function benchNetwork(port = 6379) {
  printHeader('4. Network — TCP Round-Trip (requires server on :' + port + ')');

  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    socket.setNoDelay(true);

    socket.on('error', (err) => {
      console.log(c('yellow', `  ⚠ Skipped: server not running on port ${port} (${err.code})`));
      console.log(c('gray',   '  Start the server first: node src/server/Server.js\n'));
      resolve();
    });

    socket.on('connect', async () => {
      const parser = new RespParser();

      // Measure round-trip latency
      const latencies = [];
      let   pending   = null;

      socket.on('data', (chunk) => {
        if (pending) {
          const elapsed = Number(process.hrtime.bigint() - pending.start);
          latencies.push(elapsed);
          pending.resolve();
          pending = null;
        }
      });

      const sendCmd = (args) => new Promise((res) => {
        pending = { start: process.hrtime.bigint(), resolve: res };
        socket.write(RespEncoder.encode(args));
      });

      // Warmup
      for (let i = 0; i < 100; i++) {
        await sendCmd(['PING']);
      }
      latencies.length = 0;

      // SET benchmark
      const setStart = Date.now();
      for (let i = 0; i < NET_OPS; i++) {
        await sendCmd(['SET', `bench:${i}`, `value:${i}`]);
      }
      const setElapsed = (Date.now() - setStart) / 1000;

      // GET benchmark
      latencies.length = 0;
      const getStart = Date.now();
      for (let i = 0; i < NET_OPS; i++) {
        await sendCmd(['GET', `bench:${i % NET_OPS}`]);
      }
      const getElapsed = (Date.now() - getStart) / 1000;

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(NET_OPS * 0.50)];
      const p99 = latencies[Math.floor(NET_OPS * 0.99)];

      formatResult({
        name: `SET over TCP (${NET_OPS.toLocaleString()} ops)`,
        ops: NET_OPS, opsPerSec: Math.round(NET_OPS / setElapsed),
        elapsed: setElapsed, p50, p99,
      });

      formatResult({
        name: `GET over TCP (${NET_OPS.toLocaleString()} ops)`,
        ops: NET_OPS, opsPerSec: Math.round(NET_OPS / getElapsed),
        elapsed: getElapsed, p50, p99,
      });

      // Cleanup
      await sendCmd(['FLUSHALL']);
      socket.end();
      resolve();
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(c('bold', '\n  mini-redis Benchmarks'));
  console.log(c('gray', `  ${OPS.toLocaleString()} ops per benchmark\n`));

  await benchStore();
  await benchResp();
  await benchPipeline();
  await benchNetwork();

  console.log(c('green', '\n  Done.\n'));
}

main().catch(console.error);
