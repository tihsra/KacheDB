#!/usr/bin/env node
/**
 * client.js — Interactive CLI client for mini-redis.
 *
 * Works just like redis-cli:
 *   $ node cli/client.js
 *   127.0.0.1:6379> SET foo bar
 *   OK
 *   127.0.0.1:6379> GET foo
 *   "bar"
 *   127.0.0.1:6379> EXPIRE foo 10
 *   (integer) 1
 *   127.0.0.1:6379> TTL foo
 *   (integer) 10
 *
 * FLAGS:
 *   --host   127.0.0.1
 *   --port   6379
 *
 * SPECIAL COMMANDS (client-side only):
 *   help     — show supported commands
 *   exit     — disconnect and quit
 *   clear    — clear terminal
 */

'use strict';

const net      = require('net');
const readline = require('readline');
const { RespParser, RespEncoder } = require('../src/protocol/RespParser');

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let host   = '127.0.0.1';
let port   = 6379;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host') { host = args[++i]; }
  if (args[i] === '--port') { port = parseInt(args[++i]); }
}

// ─── RESP Response Parser (client-side) ──────────────────────────────────────

/**
 * We need a simple RESP response parser for the client.
 * The server sends RESP-encoded responses; we decode them to display.
 */
function parseRespResponse(raw) {
  if (!raw || raw.length === 0) return null;

  const firstByte = raw[0];
  const rest      = raw.slice(1);

  if (firstByte === '+') {
    // Simple string
    return { type: 'string', value: rest.replace(/\r\n$/, '') };
  }

  if (firstByte === '-') {
    // Error
    return { type: 'error', value: rest.replace(/\r\n$/, '') };
  }

  if (firstByte === ':') {
    // Integer
    return { type: 'integer', value: parseInt(rest) };
  }

  if (firstByte === '$') {
    // Bulk string
    const crlfIdx = rest.indexOf('\r\n');
    if (crlfIdx === -1) return null;
    const length = parseInt(rest.slice(0, crlfIdx));
    if (length === -1) return { type: 'nil', value: null };
    const data = rest.slice(crlfIdx + 2, crlfIdx + 2 + length);
    return { type: 'bulk', value: data };
  }

  if (firstByte === '*') {
    // Array — parse each element (simplified, handles flat arrays)
    const crlfIdx = rest.indexOf('\r\n');
    const count   = parseInt(rest.slice(0, crlfIdx));
    if (count === -1) return { type: 'nil', value: null };
    if (count === 0)  return { type: 'array', value: [] };
    // For display purposes, return the raw rest for multi-line formatting
    return { type: 'array_raw', value: rest.slice(crlfIdx + 2), count };
  }

  return { type: 'unknown', value: raw };
}

// ─── Display ─────────────────────────────────────────────────────────────────

const COLORS = {
  reset  : '\x1b[0m',
  green  : '\x1b[32m',
  red    : '\x1b[31m',
  yellow : '\x1b[33m',
  cyan   : '\x1b[36m',
  gray   : '\x1b[90m',
  bold   : '\x1b[1m',
};

function colorize(str, color) {
  return COLORS[color] + str + COLORS.reset;
}

function displayResponse(raw) {
  if (!raw.trim()) return;

  // Handle multi-line responses (arrays, INFO output)
  const lines    = raw.split('\r\n').filter(l => l.length > 0);
  const firstByte = lines[0][0];

  if (firstByte === '+') {
    console.log(colorize(lines[0].slice(1), 'green'));
    return;
  }

  if (firstByte === '-') {
    console.log(colorize('(error) ' + lines[0].slice(1), 'red'));
    return;
  }

  if (firstByte === ':') {
    console.log(colorize(`(integer) ${lines[0].slice(1)}`, 'yellow'));
    return;
  }

  if (firstByte === '$') {
    const length = parseInt(lines[0].slice(1));
    if (length === -1) {
      console.log(colorize('(nil)', 'gray'));
      return;
    }
    const value = lines[1] || '';
    console.log(`"${colorize(value, 'cyan')}"`);
    return;
  }

  if (firstByte === '*') {
    const count = parseInt(lines[0].slice(1));
    if (count === -1 || count === 0) {
      console.log(colorize('(empty)', 'gray'));
      return;
    }
    // Parse array elements
    let idx = 1;
    let num = 1;
    while (idx < lines.length && num <= count) {
      const typeByte = lines[idx][0];
      if (typeByte === '$') {
        const length = parseInt(lines[idx].slice(1));
        if (length === -1) {
          console.log(`${colorize(String(num) + ')', 'gray')} ${colorize('(nil)', 'gray')}`);
          idx++;
        } else {
          idx++;
          const val = lines[idx] || '';
          console.log(`${colorize(String(num) + ')', 'gray')} "${colorize(val, 'cyan')}"`);
          idx++;
        }
      } else if (typeByte === ':') {
        console.log(`${colorize(String(num) + ')', 'gray')} ${colorize('(integer) ' + lines[idx].slice(1), 'yellow')}`);
        idx++;
      } else {
        idx++;
      }
      num++;
    }
    return;
  }

  // Fallback
  console.log(raw);
}

// ─── Help Text ───────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
${colorize('mini-redis CLI', 'bold')}

${colorize('String Commands:', 'yellow')}
  SET key value [EX seconds] [NX] [XX]
  GET key
  DEL key [key ...]
  EXISTS key [key ...]
  APPEND key value
  INCR key
  DECR key
  MSET key value [key value ...]
  MGET key [key ...]

${colorize('Expiry Commands:', 'yellow')}
  EXPIRE key seconds
  TTL key
  PERSIST key

${colorize('Server Commands:', 'yellow')}
  PING [message]
  ECHO message
  KEYS [pattern]
  DBSIZE
  FLUSHALL
  INFO
  COMMAND

${colorize('Client Commands:', 'yellow')}
  help           — show this help
  clear          — clear terminal
  exit / quit    — disconnect
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const socket = net.createConnection(port, host);
  let   buffer = '';

  socket.setNoDelay(true);

  socket.on('connect', () => {
    console.log(colorize(`Connected to mini-redis at ${host}:${port}`, 'green'));
    console.log(colorize('Type "help" for commands, "exit" to quit', 'gray'));
    console.log('');
    rl.prompt();
  });

  socket.on('data', (chunk) => {
    buffer += chunk.toString();

    // Simple heuristic: response is complete if it ends with \r\n
    // For arrays and bulk strings we wait for the full payload
    // This works for our interactive use case
    if (buffer.endsWith('\r\n')) {
      displayResponse(buffer);
      buffer = '';
      rl.prompt();
    }
  });

  socket.on('error', (err) => {
    console.error(colorize(`\nConnection error: ${err.message}`, 'red'));
    if (err.code === 'ECONNREFUSED') {
      console.error(colorize(`Is mini-redis running on ${host}:${port}?`, 'gray'));
    }
    process.exit(1);
  });

  socket.on('close', () => {
    console.log(colorize('\nDisconnected', 'gray'));
    process.exit(0);
  });

  // ── Readline interface ───────────────────────────────────────────────────

  const rl = readline.createInterface({
    input    : process.stdin,
    output   : process.stdout,
    prompt   : colorize(`${host}:${port}> `, 'bold'),
    terminal : true,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); return; }

    // Client-side commands (don't send to server)
    if (trimmed.toLowerCase() === 'help') {
      showHelp();
      rl.prompt();
      return;
    }

    if (trimmed.toLowerCase() === 'clear') {
      process.stdout.write('\x1b[2J\x1b[0f');
      rl.prompt();
      return;
    }

    if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
      console.log(colorize('Goodbye!', 'green'));
      socket.end();
      rl.close();
      return;
    }

    // Parse the command into tokens (respects quoted strings)
    const tokens = parseCommandLine(trimmed);
    if (tokens.length === 0) { rl.prompt(); return; }

    // Encode as RESP array and send to server
    const encoded = RespEncoder.encode(tokens);
    socket.write(encoded);
    // Don't prompt again — wait for the server response
  });

  rl.on('close', () => {
    socket.end();
    process.exit(0);
  });
}

/**
 * Parse a command line into tokens, respecting quoted strings.
 * "SET key hello world" → ["SET", "key", "hello world"]
 */
function parseCommandLine(line) {
  const tokens  = [];
  let   current = '';
  let   inQuote = false;
  let   quoteChar = '';

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && !inQuote) {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === quoteChar && inQuote) {
      inQuote = false;
    } else if (ch === ' ' && !inQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

main();
