/**
 * Custom stdio transport that supports both Content-Length framing (MCP spec / Claude Code)
 * and newline framing (SDK default).
 *
 * The MCP SDK's StdioServerTransport only reads newline-delimited JSON,
 * but Claude Code sends Content-Length framed messages per the MCP spec.
 */

import { process } from '@modelcontextprotocol/server/_shims';
import type { Transport } from '@modelcontextprotocol/server';

interface TransportCallbacks {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;
}

export class StdioServerTransport implements Transport {
  _stdin: NodeJS.ReadStream;
  _stdout: NodeJS.WriteStream;
  _started = false;
  _closed = false;
  _buffer = Buffer.alloc(0);

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: unknown) => void;

  constructor(
    stdin = process.stdin,
    stdout = process.stdout,
  ) {
    this._stdin = stdin;
    this._stdout = stdout;
  }

  async start() {
    if (this._started) throw new Error('StdioServerTransport already started');
    this._started = true;
    this._stdin.on('data', this._ondata);
    this._stdin.on('error', this._onerror);
    this._stdout.on('error', this._onstdouterror);
  }

  _ondata = (chunk: Buffer) => {
    try {
      this._buffer = Buffer.concat([this._buffer, chunk]);
      this.processReadBuffer();
    } catch (err) {
      this.onerror?.(err as Error);
    }
  };

  _onerror = (err: Error) => {
    this.onerror?.(err);
  };

  _onstdouterror = (err: Error) => {
    this.onerror?.(err);
  };

  processReadBuffer() {
    // Try Content-Length framing first (MCP spec / Claude Code)
    // Format: "Content-Length: <N>\r\n\r\n<JSON>\n"
    while (this._buffer.length > 0) {
      // Look for "Content-Length:" header
      const clIdx = this._buffer.indexOf('Content-Length:');
      if (clIdx === -1) {
        // No Content-Length header — try newline framing (SDK default)
        this._processNewlineFraming();
        return;
      }

      // Parse Content-Length header
      const headerEnd = this._buffer.indexOf('\r\n\r\n', clIdx);
      if (headerEnd === -1) {
        // Incomplete header, wait for more data
        return;
      }

      const headerLine = this._buffer.toString('utf8', clIdx, headerEnd);
      const match = headerLine.match(/Content-Length:\s*(\d+)/);
      if (!match) {
        // Invalid header, skip to next line
        const nextNewline = this._buffer.indexOf('\n', clIdx);
        if (nextNewline === -1) return;
        this._buffer = this._buffer.subarray(nextNewline + 1);
        continue;
      }

      const contentLen = parseInt(match[1], 10);
      const payloadStart = headerEnd + 4; // skip \r\n\r\n
      const payloadEnd = payloadStart + contentLen;

      if (this._buffer.length < payloadEnd) {
        // Incomplete payload, wait for more data
        return;
      }

      // Extract and parse the JSON message
      const payload = this._buffer.slice(payloadStart, payloadEnd);
      try {
        const message = JSON.parse(payload.toString('utf8'));
        this.onmessage?.(message);
      } catch (err) {
        this.onerror?.(new Error(`Failed to parse JSON: ${err}`));
      }

      // Advance past the message (and optional trailing newline)
      this._buffer = this._buffer.subarray(payloadEnd + 1); // +1 for trailing \n
    }
  }

  _processNewlineFraming() {
    // Fallback: newline-delimited JSON (SDK default)
    while (this._buffer.length > 0) {
      const nlIdx = this._buffer.indexOf('\n');
      if (nlIdx === -1) return;

      const line = this._buffer.toString('utf8', 0, nlIdx).replace(/\r$/, '');
      this._buffer = this._buffer.subarray(nlIdx + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line);
        this.onmessage?.(message);
      } catch {
        // Skip unparseable lines
      }
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._stdin.off('data', this._ondata);
    this._stdin.off('error', this._onerror);
    this._stdout.off('error', this._onstdouterror);
    this._buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  send(message: unknown): Promise<void> {
    if (this._closed) return Promise.reject(new Error('Transport is closed'));

    // Use Content-Length framing for responses (MCP spec)
    const json = JSON.stringify(message);
    const encoded = Buffer.from(json, 'utf8');
    const header = `Content-Length: ${encoded.length}\r\n\r\n`;
    const headerBuf = Buffer.from(header, 'utf8');

    return new Promise((resolve, reject) => {
      let settled = false;
      const onDone = (err?: Error) => {
        if (settled) return;
        settled = true;
        this._stdout.off('error', onError);
        this._stdout.off('drain', onDrain);
        if (err) reject(err);
        else resolve();
      };

      const onError = (err: Error) => onDone(err);
      const onDrain = () => onDone();

      this._stdout.once('error', onError);

      // Write header + body in one go
      if (this._stdout.write(headerBuf) && this._stdout.write(encoded) && this._stdout.write('\n')) {
        onDone();
      } else {
        this._stdout.once('drain', onDrain);
      }
    });
  }

  setProtocolVersion?(_version: string) {
    // No-op for stdio
  }
}
