/**
 * RespParser.js — Redis Serialization Protocol (RESP) Parser.
 *
 * RESP is the wire protocol Redis uses. It's a text-based protocol
 * designed to be simple to parse and human-readable enough to debug
 * with netcat. Every Redis client in every language speaks RESP.
 *
 * WHY NOT HTTP?
 *   HTTP has huge overhead — headers, method lines, status codes,
 *   content-type negotiation. For a key-value store doing millions
 *   of operations per second, that overhead is unacceptable.
 *   RESP is minimal: a type byte, a length, a \r\n, the data, another \r\n.
 *   Parsing is O(n) in message length with no backtracking.
 *
 * RESP DATA TYPES:
 *   +OK\r\n               → Simple string  (server → client, for "OK" etc.)
 *   -ERR message\r\n      → Error          (server → client)
 *   :42\r\n               → Integer        (server → client)
 *   $6\r\nfoobar\r\n      → Bulk string    (both directions, binary-safe)
 *   $-1\r\n               → Null bulk string (nil)
 *   *3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n  → Array of 3 bulk strings
 *
 * INLINE COMMANDS (for human use with telnet/netcat):
 *   SET foo bar\r\n       → parsed as ["SET", "foo", "bar"]
 *   These don't use the * prefix, just space-separated words.
 *
 * PARTIAL READS — The Hard Part:
 *   TCP is a stream protocol. One send() call on the client side does NOT
 *   guarantee one recv() call on the server side. The data may arrive in
 *   chunks. We handle this by buffering incoming bytes and only consuming
 *   a message when we've confirmed it's complete.
 *
 *   Example of a partial read:
 *     Chunk 1: "*2\r\n$3\r\n"
 *     Chunk 2: "GET\r\n$4\r\nname\r\n"
 *   The parser buffers chunk 1, receives chunk 2, and only then parses
 *   the complete message.
 */

class RespParser {
  constructor() {
    // Raw bytes buffer. We accumulate here until we have a complete message.
    this._buffer = '';
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Feed incoming bytes into the parser.
   * Returns an array of complete parsed commands.
   * May return [] if the data is incomplete (need more bytes).
   * May return multiple commands if the buffer contained more than one.
   *
   * @param {string|Buffer} data — incoming TCP chunk
   * @returns {Array<string[]>} — array of parsed commands, each command is
   *                              an array of strings e.g. ["SET", "foo", "bar"]
   */
  feed(data) {
    this._buffer += data.toString();
    const commands = [];

    // Keep parsing as long as there's a complete message in the buffer
    while (this._buffer.length > 0) {
      const result = this._tryParse();
      if (result === null) break; // incomplete message — wait for more data
      commands.push(result);
    }

    return commands;
  }

  /**
   * Reset the buffer. Call this if the connection is closed or on error.
   */
  reset() {
    this._buffer = '';
  }

  // ─── Parsing ─────────────────────────────────────────────────────────────────

  /**
   * Try to parse one complete message from the buffer.
   * Returns the parsed command array, or null if the message is incomplete.
   * MUTATES this._buffer — consumes the bytes of a successfully parsed message.
   */
  _tryParse() {
    if (this._buffer.length === 0) return null;

    const firstByte = this._buffer[0];

    if (firstByte === '*') {
      // Array type — this is the standard client → server format
      return this._parseArray();
    } else {
      // Inline command — "SET foo bar\r\n" without the RESP framing
      // Used when humans type directly into telnet/netcat
      return this._parseInline();
    }
  }

  /**
   * Parse a RESP array: *<count>\r\n followed by <count> bulk strings.
   *
   * Example:
   *   *3\r\n
   *   $3\r\nSET\r\n
   *   $3\r\nfoo\r\n
   *   $3\r\nbar\r\n
   *
   * Parsed result: ["SET", "foo", "bar"]
   */
  _parseArray() {
    // Find the end of the first line
    const crlfIdx = this._buffer.indexOf('\r\n');
    if (crlfIdx === -1) return null; // incomplete

    const countStr = this._buffer.slice(1, crlfIdx); // skip the '*'
    const count    = parseInt(countStr, 10);

    if (isNaN(count)) {
      // Malformed — discard the line and return an error command
      this._buffer = this._buffer.slice(crlfIdx + 2);
      return ['__PARSE_ERROR__', 'Invalid array count'];
    }

    if (count === -1) {
      // Null array
      this._buffer = this._buffer.slice(crlfIdx + 2);
      return null;
    }

    // Now parse exactly `count` bulk strings
    let pos      = crlfIdx + 2; // position after the *<count>\r\n line
    const args   = [];

    for (let i = 0; i < count; i++) {
      const result = this._parseBulkAt(pos);
      if (result === null) return null; // incomplete

      args.push(result.value);
      pos = result.nextPos;
    }

    // Consume the parsed bytes from the buffer
    this._buffer = this._buffer.slice(pos);
    return args;
  }

  /**
   * Parse a single bulk string starting at `pos` in the buffer.
   * Bulk string format: $<length>\r\n<data>\r\n
   *
   * Returns { value: string, nextPos: number } or null if incomplete.
   */
  _parseBulkAt(pos) {
    if (pos >= this._buffer.length) return null;

    if (this._buffer[pos] !== '$') {
      // Not a bulk string — something is wrong
      return null;
    }

    const crlfIdx = this._buffer.indexOf('\r\n', pos);
    if (crlfIdx === -1) return null; // incomplete

    const lengthStr = this._buffer.slice(pos + 1, crlfIdx);
    const length    = parseInt(lengthStr, 10);

    if (isNaN(length)) return null;

    if (length === -1) {
      // Null bulk string (nil)
      return { value: null, nextPos: crlfIdx + 2 };
    }

    // The data starts after the $<length>\r\n line
    const dataStart = crlfIdx + 2;
    const dataEnd   = dataStart + length;

    // Do we have enough bytes?
    if (this._buffer.length < dataEnd + 2) return null; // +2 for trailing \r\n

    const value = this._buffer.slice(dataStart, dataEnd);

    // Consume the trailing \r\n after the data
    return { value, nextPos: dataEnd + 2 };
  }

  /**
   * Parse an inline command: space-separated tokens terminated by \r\n or \n.
   *
   * Example: "GET foo\r\n" → ["GET", "foo"]
   *
   * Inline commands don't support binary data (no length prefix) but they're
   * human-friendly for testing with telnet.
   */
  _parseInline() {
    // Look for \r\n or just \n (some clients only send \n)
    let lineEnd = this._buffer.indexOf('\r\n');
    let advance = 2;
    if (lineEnd === -1) {
      lineEnd = this._buffer.indexOf('\n');
      advance = 1;
    }
    if (lineEnd === -1) return null; // incomplete

    const line = this._buffer.slice(0, lineEnd).trim();
    this._buffer = this._buffer.slice(lineEnd + advance);

    if (line.length === 0) return null; // blank line — skip

    // Split by whitespace, handling quoted strings: GET "hello world"
    return this._splitInline(line);
  }

  /**
   * Split an inline command line respecting double-quoted strings.
   * "SET key hello world"  → ["SET", "key", "hello world"]
   */
  _splitInline(line) {
    const tokens = [];
    let current  = '';
    let inQuote  = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuote = !inQuote;
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
}

// ─── RespEncoder ─────────────────────────────────────────────────────────────

/**
 * Encodes JavaScript values into RESP format for sending back to clients.
 *
 * RESP response types:
 *   Simple string → "+OK\r\n"
 *   Error         → "-ERR message\r\n"
 *   Integer       → ":42\r\n"
 *   Bulk string   → "$6\r\nfoobar\r\n"
 *   Null          → "$-1\r\n"
 *   Array         → "*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n"
 */
class RespEncoder {
  /**
   * Encode any JavaScript value to RESP.
   * This is the main entry point — it dispatches based on type.
   */
  static encode(value) {
    if (value === null || value === undefined) {
      return '$-1\r\n'; // null bulk string
    }

    if (value instanceof Error) {
      return `-${value.message}\r\n`; // error
    }

    if (typeof value === 'number' && Number.isInteger(value)) {
      return `:${value}\r\n`; // integer
    }

    if (typeof value === 'string') {
      // Use bulk string (binary-safe) rather than simple string
      // Simple strings (+) cannot contain \r or \n
      return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
    }

    if (Array.isArray(value)) {
      // Encode each element recursively
      let out = `*${value.length}\r\n`;
      for (const item of value) {
        out += RespEncoder.encode(item);
      }
      return out;
    }

    // Fallback — convert to string
    const str = String(value);
    return `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
  }

  /**
   * Simple string response — used for "OK", "PONG" etc.
   * Faster than bulk string for these cases.
   */
  static simpleString(str) {
    return `+${str}\r\n`;
  }

  /**
   * Error response.
   */
  static error(message) {
    return `-ERR ${message}\r\n`;
  }
}

module.exports = { RespParser, RespEncoder };
