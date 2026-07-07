import { Client } from 'ssh2';
import type { ServerConfig, ExecResult } from './types.js';
import { expandPath } from './utils.js';
import { readFileSync } from 'node:fs';

export interface SshSession {
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  status(): Promise<StatusInfo>;
  destroy(): void;
}

export interface ExecOptions {
  timeout?: number;
  cwd?: string;
}

export interface StatusInfo {
  host: string;
  port: number;
  username: string;
  hostname: string;
  shell: string;
  connected: boolean;
}

function buildConnectionConfig(config: ServerConfig): Record<string, unknown> {
  const base: Record<string, unknown> = {
    host: config.ssh.host,
    port: config.ssh.port,
    username: config.ssh.username,
    readyTimeout: 30000,
  };

  if (config.ssh.keyPath) {
    const keyPath = expandPath(config.ssh.keyPath);
    const keyConfig: Record<string, unknown> = {
      privateKey: readFileSync(keyPath),
    };
    if (config.ssh.passphrase) {
      keyConfig.passphrase = config.ssh.passphrase;
    }
    return { ...base, ...keyConfig };
  }

  if (config.ssh.password) {
    return { ...base, password: config.ssh.password };
  }

  throw new Error(
    'No authentication method configured. Provide --key or --password.',
  );
}

function buildCwdPrefix(cwd: string | undefined): string {
  if (cwd) {
    return `cd '${cwd}' && `;
  }
  return '';
}

export function createSshSession(config: ServerConfig): SshSession {
  function exec(
    command: string,
    options: ExecOptions,
  ): Promise<ExecResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeout ?? 60000;

    return new Promise<ExecResult>((resolve, reject) => {
      const conn = new Client();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        conn.end();
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          exitCode: null,
          signal: null,
          duration: Date.now() - startTime,
          timedOut: true,
          truncated: false,
        });
      }, timeoutMs);

      conn.on('error', (err) => {
        if (!timedOut) {
          clearTimeout(timer);
          reject(new Error(`SSH connection error: ${err.message}`));
        }
      });

      conn.on('close', () => {
        if (!timedOut) {
          clearTimeout(timer);
        }
      });

      conn.on('ready', () => {
        const cwdPrefix = buildCwdPrefix(options.cwd);
        const wrappedCommand = `${cwdPrefix}${command}`;

        conn.exec(wrappedCommand, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            reject(new Error(`SSH exec error: ${err.message}`));
            return;
          }

          stream.on('close', (code: number, signal: string) => {
            clearTimeout(timer);
            resolve({
              stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
              stderr: Buffer.concat(stderrChunks).toString('utf-8'),
              exitCode: code,
              signal: signal || null,
              duration: Date.now() - startTime,
              timedOut: false,
              truncated: false,
            });
          });

          stream.on('data', (data: Buffer) => {
            stdoutChunks.push(data);
          });

          stream.stderr?.on('data', (data: Buffer) => {
            stderrChunks.push(data);
          });

          stream.stderr?.on('error', () => {
            // ignore stderr errors (e.g. when command has no stderr)
          });

          stream.on('error', () => {
            // ignore stream errors on close
          });
        });
      });

      conn.connect(buildConnectionConfig(config));
    });
  }

  function status(): Promise<StatusInfo> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error('Status check timed out'));
      }, 10000);

      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`SSH connection error: ${err.message}`));
      });

      conn.on('ready', () => {
        conn.exec('hostname', (err, stream) => {
          if (err) {
            clearTimeout(timer);
            reject(new Error(`SSH exec error: ${err.message}`));
            return;
          }

          let hostname = '';
          stream.on('close', (code: number) => {
            clearTimeout(timer);
            if (code !== 0) {
              reject(new Error(`hostname command failed with code ${code}`));
              return;
            }
            resolve({
              host: config.ssh.host,
              port: config.ssh.port,
              username: config.ssh.username,
              hostname: hostname.trim(),
              shell: config.shell,
              connected: true,
            });
          });

          stream.on('data', (data: Buffer) => {
            hostname += data.toString('utf-8');
          });
        });
      });

      conn.connect(buildConnectionConfig(config));
    });
  }

  function destroy(): void {
    // Stateless: nothing to clean up
  }

  return { exec, status, destroy };
}
