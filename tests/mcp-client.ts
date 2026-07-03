import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * mcp.json lives at the project root, two levels up from tests/dist/.
 */
function getProjectRoot(): string {
  return dirname(dirname(__dirname));
}

interface McpConfig {
  command: string;
  args: string[];
}

interface McpMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Reads mcp.json and extracts the rbash server config.
 */
export function loadMcpConfig(): McpConfig {
  const mcpPath = join(getProjectRoot(), 'mcp.json');
  const raw = readFileSync(mcpPath, 'utf-8');
  const config = JSON.parse(raw) as { mcpServers: Record<string, McpConfig> };
  const server = config.mcpServers['rbash'];
  if (!server) {
    throw new Error('No "rbash" server found in mcp.json');
  }
  return server;
}

/**
 * MCP client over stdio transport. Communicates with the rbash MCP server
 * by spawning it and exchanging JSON-RPC messages.
 */
export class McpClient {
  private proc: ChildProcess | null = null;
  private messageId = 0;
  private pending = new Map<number | string, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private buffer = '';

  async start(): Promise<void> {
    const config = loadMcpConfig();
    this.proc = spawn(config.command, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      // Suppress stderr for cleaner test output
    });

    this.proc.on('error', (err: Error) => {
      for (const [, pending] of this.pending) {
        pending.reject(err);
      }
      this.pending.clear();
    });

    this.proc.on('exit', (code: number | null) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`rbash process exited with code ${code}`));
      }
      this.pending.clear();
    });

    // Send initialize + initialized + tools/list
    await this.initialize();
    await this.listTools();
  }

  private processBuffer(): void {
    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx === -1) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      try {
        const msg: McpMessage = JSON.parse(line);
        if (msg.id !== undefined) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            this.pending.delete(msg.id);
            if (msg.error) {
              pending.reject(new Error(`MCP error: ${msg.error.message}`));
            } else {
              pending.resolve(msg.result);
            }
          }
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error('Process not started'));
        return;
      }
      const id = ++this.messageId;
      const msg: McpMessage = { jsonrpc: '2.0', id, method, params };
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify(msg) + '\n');

      // Safety timeout
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 5000);
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.proc?.stdin) return;
    const msg: McpMessage = { jsonrpc: '2.0', method, params };
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private async initialize(): Promise<void> {
    const initResult = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rbash-test', version: '0.1.0' },
    });
    // Send initialized notification (no id = notification)
    await this.sendNotification('notifications/initialized', {});
    return initResult as void;
  }

  async listTools(): Promise<Array<{ name: string; description: string }>> {
    const result = await this.send('tools/list', {});
    const tools = (result as { tools?: Array<{ name: string; description: string }> })?.tools || [];
    return tools.map((t) => ({ name: t.name, description: t.description }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    isError: boolean;
    structuredContent?: Record<string, unknown>;
  }> {
    const result = await this.send('tools/call', { name, arguments: args });
    const resp = result as {
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    return {
      content: resp.content || [],
      isError: resp.isError || false,
      structuredContent: resp.structuredContent,
    };
  }

  async stop(): Promise<void> {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
  }
}
