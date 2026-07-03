import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const mcpPath = '/mnt/LinuxAISystem/_apps/rbash/mcp.json';
const config = JSON.parse(readFileSync(mcpPath, 'utf-8')).mcpServers['rbash'];

console.log('Starting rbash server...');
const proc = spawn(config.command, config.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';

proc.stdout?.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf-8');
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) {
      console.log('[SERVER]', line);
    }
  }
});

proc.stderr?.on('data', (chunk: Buffer) => {
  console.log('[STDERR]', chunk.toString('utf-8'));
});

proc.on('exit', (code, signal) => {
  console.log(`[EXIT] code=${code}, signal=${signal}`);
  process.exit(code ?? 0);
});

proc.on('error', (err) => {
  console.log('[ERROR]', err.message);
  process.exit(1);
});

// Send initialize
setTimeout(() => {
  console.log('Sending initialize...');
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  }) + '\n');
}, 1000);

// Send initialized
setTimeout(() => {
  console.log('Sending initialized...');
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  }) + '\n');
}, 2000);

// Send tools/list
setTimeout(() => {
  console.log('Sending tools/list...');
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }) + '\n');
}, 3000);

// Send tools/call
setTimeout(() => {
  console.log('Sending tools/call...');
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'bash',
      arguments: { command: 'echo hello' },
    },
  }) + '\n');
}, 4000);

// Wait for response
setTimeout(() => {
  console.log('Timeout waiting for response, exiting...');
  proc.kill();
  process.exit(0);
}, 10000);
