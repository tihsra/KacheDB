/**
 * ClientHandler.js — one instance per TCP connection. Reads bytes from the
 * socket, feeds them to the RespParser (which handles partial reads), runs each
 * complete command through the CommandProcessor, encodes the result, and writes
 * it back. Pipelined commands that arrive in one packet are processed together
 * and their responses sent in a single write.
 */

const { RespParser, RespEncoder } = require('../protocol/RespParser');

class ClientHandler {
  /**
   * @param {net.Socket}       socket    — the TCP socket for this client
   * @param {CommandProcessor} processor — to execute commands
   * @param {StatsCollector}   stats     — to record metrics
   * @param {Function}         onClose   — called when this client disconnects
   */
  constructor(socket, processor, stats, onClose) {
    this._socket    = socket;
    this._processor = processor;
    this._stats     = stats;
    this._onClose   = onClose;
    this._parser    = new RespParser();

    // Unique ID for logging
    this._id = `${socket.remoteAddress}:${socket.remotePort}`;

    this._setupSocket();
  }

  // ─── Setup ───────────────────────────────────────────────────────────────────

  _setupSocket() {
    // Set TCP keepalive — detect dead connections after 60s
    this._socket.setKeepAlive(true, 60_000);

    // No Nagle — send small packets immediately (low latency > throughput here)
    this._socket.setNoDelay(true);

    this._socket.on('data', (chunk) => this._onData(chunk));
    this._socket.on('close', ()      => this._onClose(this._id));
    this._socket.on('error', (err)   => this._onError(err));

    console.log(`[Client ${this._id}] Connected`);
  }

  // ─── Data Handling ───────────────────────────────────────────────────────────

  /**
   * Called whenever the socket receives data.
   * May be called multiple times for one logical message (partial reads).
   * May receive multiple messages in one chunk (pipelining).
   */
  _onData(chunk) {
    // Feed raw bytes into the parser
    // Returns zero or more complete commands
    const commands = this._parser.feed(chunk);

    if (commands.length === 0) return; // incomplete message — wait for more

    // Collect all responses and send in one write (pipeline-friendly)
    let responseBuffer = '';

    for (const args of commands) {
      const result   = this._processor.process(args);
      const encoded  = this._encodeResult(result);
      responseBuffer += encoded;

      // Record for stats dashboard
      this._stats.recordCommand();
    }

    // Write all responses in one syscall
    if (responseBuffer && !this._socket.destroyed) {
      this._socket.write(responseBuffer);
    }
  }

  // ─── Response Encoding ───────────────────────────────────────────────────────

  /**
   * Encode a command result to RESP format.
   * Handles the special case of "OK" as a simple string for efficiency.
   */
  _encodeResult(result) {
    if (result === 'OK' || result === 'PONG') {
      return RespEncoder.simpleString(result);
    }
    return RespEncoder.encode(result);
  }

  // ─── Error / Close ───────────────────────────────────────────────────────────

  _onError(err) {
    // ECONNRESET = client closed connection abruptly (closed tab, killed process)
    // This is normal — don't log as an error
    if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
      console.warn(`[Client ${this._id}] Error: ${err.message}`);
    }
    this._parser.reset();
  }

  /**
   * Gracefully close this client's connection.
   */
  destroy() {
    if (!this._socket.destroyed) {
      this._socket.destroy();
    }
  }

  getId() {
    return this._id;
  }
}

module.exports = ClientHandler;
