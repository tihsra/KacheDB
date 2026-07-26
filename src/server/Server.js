/**
 * Server.js — entry point. Wires the subsystems together and starts the TCP
 * server (plus a WebSocket server for the dashboard).
 *
 * Startup: parse flags, build Store/WAL/Snapshot/ExpiryManager/CommandProcessor,
 * load the latest snapshot, replay the WAL written after it, start the expiry
 * sweep and snapshot timer, set up replication (leader opens a port, follower
 * connects), then accept clients. Shutdown takes a final snapshot and flushes
 * the WAL.
 *
 * Flags: --port (6379), --data-dir (./data), --role standalone|leader|follower,
 * --leader-host, --leader-port, --repl-port (7379), --stats-port (8379).
 */

'use strict';

const net  = require('net');
const ws   = require('ws');

const Store            = require('../core/Store');
const ExpiryManager    = require('../core/ExpiryManager');
const CommandProcessor = require('../core/CommandProcessor');
const { RespParser, RespEncoder } = require('../protocol/RespParser');
const WAL              = require('../persistence/WAL');
const Snapshot         = require('../persistence/Snapshot');
const { Leader, Follower } = require('../replication/Replication');
const StatsCollector   = require('../stats/StatsCollector');
const ClientHandler    = require('./ClientHandler');

// ─── CLI Argument Parsing ─────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg  = {
    port       : 6379,
    dataDir    : './data',
    role       : 'standalone', // standalone | leader | follower
    leaderHost : '127.0.0.1',
    leaderPort : 6379,
    replPort   : 7379,
    statsPort  : 8379,
  };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const val  = args[i + 1];
    switch (flag) {
      case '--port':        cfg.port        = parseInt(val); i++; break;
      case '--data-dir':    cfg.dataDir     = val;            i++; break;
      case '--role':        cfg.role        = val;            i++; break;
      case '--leader-host': cfg.leaderHost  = val;            i++; break;
      case '--leader-port': cfg.leaderPort  = parseInt(val); i++; break;
      case '--repl-port':   cfg.replPort    = parseInt(val); i++; break;
      case '--stats-port':  cfg.statsPort   = parseInt(val); i++; break;
    }
  }
  return cfg;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs();

  console.log('');
  console.log('┌─────────────────────────────────────────┐');
  console.log('│          mini-redis starting up          │');
  console.log(`│  role: ${cfg.role.padEnd(33)}│`);
  console.log(`│  port: ${String(cfg.port).padEnd(33)}│`);
  console.log('└─────────────────────────────────────────┘');
  console.log('');

  // ── 1. Create core subsystems ─────────────────────────────────────────────

  const store   = new Store();
  const expiry  = new ExpiryManager(store);
  const stats   = new StatsCollector();
  const wal     = new WAL(`${cfg.dataDir}/wal.log`);
  const snapshot = new Snapshot(cfg.dataDir, store, wal);

  // ── 2. Restore state from disk ────────────────────────────────────────────

  wal.open();

  // Load latest snapshot (returns WAL byte offset of when snapshot was taken)
  const walOffset = snapshot.load();

  // Replay WAL entries written after the snapshot
  const walEntries = wal.replay(walOffset);
  if (walEntries.length > 0) {
    console.log(`[Startup] Replaying ${walEntries.length} WAL entries...`);

    // Temporary processor for replay (no WAL write, no replication during replay)
    const replayProcessor = new CommandProcessor(store, null, null);
    for (const entry of walEntries) {
      replayProcessor.process(entry, true);
    }
    console.log('[Startup] WAL replay complete');
  }

  // ── 3. Set up replication ─────────────────────────────────────────────────

  let leader   = null;
  let follower = null;

  // CommandProcessor's onWrite callback: called after every successful write
  // Used to (a) stream commands to followers and (b) record to WAL
  const onWrite = (args) => {
    if (leader) leader.broadcast(args);
  };

  // Create the main command processor
  const processor = new CommandProcessor(store, wal, onWrite);

  if (cfg.role === 'leader') {
    leader = new Leader(cfg.replPort, store, snapshot);
    leader.start();
  } else if (cfg.role === 'follower') {
    const leaderReplPort = cfg.leaderPort + 1000; // convention: repl port = client port + 1000
    follower = new Follower(cfg.leaderHost, leaderReplPort, store, processor);
    follower.connect();
  }

  // ── 4. Start background tasks ─────────────────────────────────────────────

  expiry.start();
  snapshot.startAutoSnapshot();

  // ── 5. Register everything with StatsCollector ────────────────────────────

  stats.register({ store, wal, expiry, leader, follower });

  // ── 6. Start TCP server for clients ──────────────────────────────────────

  const clients = new Map(); // clientId → ClientHandler

  const tcpServer = net.createServer((socket) => {
    // Followers are read-only — they don't accept write commands
    // We wrap the processor to reject writes if we're a follower
    const effectiveProcessor = cfg.role === 'follower'
      ? makeReadOnlyProcessor(processor)
      : processor;

    const handler = new ClientHandler(
      socket,
      effectiveProcessor,
      stats,
      (id) => {
        clients.delete(id);
        stats.setConnectedClients(clients.size);
        console.log(`[Server] Client disconnected: ${id} (${clients.size} remaining)`);
      }
    );

    clients.set(handler.getId(), handler);
    stats.setConnectedClients(clients.size);
  });

  tcpServer.listen(cfg.port, () => {
    console.log(`[Server] Listening on port ${cfg.port}`);
    console.log(`[Server] Connect with: node cli/client.js --port ${cfg.port}`);
    console.log(`[Server] Or with: redis-cli -p ${cfg.port}`);
  });

  // ── 7. Start WebSocket server for React dashboard ────────────────────────
  
  // issue is that both follower and main create client dashboard at same port causing 
  // collision
  // will resolve later 

  /*
  const wss = new ws.WebSocketServer({ port: cfg.statsPort });

  wss.on('connection', (wsClient) => {
    console.log('[Dashboard] Client connected');

    // Send stats immediately, then every second
    const send = () => {
      if (wsClient.readyState === ws.OPEN) {
        wsClient.send(JSON.stringify(stats.collect()));
      }
    };

    send();
    const interval = setInterval(send, 1000);

    wsClient.on('close', () => {
      clearInterval(interval);
      console.log('[Dashboard] Client disconnected');
    });
  });

  console.log(`[Dashboard] WebSocket on port ${cfg.statsPort}`);
  console.log(`[Dashboard] Open dashboard/index.html in your browser`);
  */ 

  // ── 8. Graceful shutdown ──────────────────────────────────────────────────

  const shutdown = async (signal) => {
    console.log(`\n[Server] Received ${signal} — shutting down gracefully`);

    // Stop accepting new connections
    tcpServer.close();
    wss.close();

    // Destroy existing client connections
    for (const handler of clients.values()) {
      handler.destroy();
    }

    // Stop replication
    if (leader)   leader.stop();
    if (follower) follower.disconnect();

    // Stop background tasks
    expiry.stop();
    snapshot.stopAutoSnapshot();
    stats.stop();

    // Take a final snapshot
    console.log('[Server] Taking final snapshot...');
    try { snapshot.save(); } catch (e) { console.error('[Server] Final snapshot failed:', e.message); }

    // Flush WAL
    wal.close();

    console.log('[Server] Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ─── Read-Only Processor Wrapper ──────────────────────────────────────────────

/**
 * Wraps a CommandProcessor to reject write commands.
 * Used on followers — they only serve reads.
 */
function makeReadOnlyProcessor(processor) {
  const WRITE_COMMANDS = new Set([
    'SET', 'DEL', 'EXPIRE', 'PERSIST', 'INCR', 'DECR',
    'APPEND', 'FLUSHALL', 'MSET',
  ]);

  return {
    process(args, fromReplication) {
      if (!fromReplication && args.length > 0 && WRITE_COMMANDS.has(args[0].toUpperCase())) {
        return new Error('READONLY You can\'t write against a read only replica');
      }
      return processor.process(args, fromReplication);
    }
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
