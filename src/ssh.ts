import { Client, type ClientChannel } from 'ssh2';
import type { ServerConfig, ExecResult } from './types.js';
import { expandPath } from './utils.js';
import { readFileSync } from 'node:fs';

export interface SshSession {
  exec(command: string, options: ExecOptions): Promise<ExecResult>;
  status(): Promise<StatusInfo>;
  destroy(): void;
}

export interface ExecOptions {
  stdin?: string;
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

const PROMPT = 'rbash-prompt-$$';

function buildConnectionConfig(config: ServerConfig): Record<string, unknown> {
  const base: Record<string, unknown> = {
    host: config.ssh.host,
    port: config.ssh.port,
    username: config.ssh.username,
    readyTimeout: 30000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
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

export function createSshSession(config: ServerConfig): SshSession {
  let conn: Client | null = null;
  let shell: ClientChannel | null = null;
  let shellReady = false;
  let pendingError: Error | null = null;

  function resetState(): void {
    if (shell) {
      try {
        shell.removeAllListeners('data');
        shell.removeAllListeners('close');
        shell.removeAllListeners('error');
        shell.end();
      } catch {
        /* ignore */
      }
      shell = null;
    }
    if (conn) {
      try {
        conn.removeAllListeners('ready');
        conn.removeAllListeners('error');
        conn.removeAllListeners('close');
        conn.end();
      } catch {
        /* ignore */
      }
      conn = null;
    }
    shellReady = false;
    pendingError = null;
  }

  function ensureSession(): Promise<ClientChannel> {
    if (conn && shell && shellReady) {
      return Promise.resolve(shell);
    }

    resetState();

    return new Promise<ClientChannel>((resolve, reject) => {
      conn = new Client();

      const onError = (err: Error) => {
        reject(new Error(`SSH connection error: ${err.message}`));
      };

      const onClose = () => {
        if (pendingError) {
          reject(pendingError);
        } else {
          reject(new Error('SSH connection closed unexpectedly'));
        }
      };

      conn.on('error', onError);
      conn.on('close', onClose);

      conn.on('ready', () => {
        conn!.off('error', onError);
        conn!.off('close', onClose);

        conn!.shell(
          {
            term: config.term || 'xterm-256color',
          },
          (err, stream) => {
            if (err) {
              conn!.end();
              reject(new Error(`SSH shell error: ${err.message}`));
              return;
            }

            shell = stream;
            shellReady = true;

            // Set shell, disable prompt, and change to starting directory
            stream.write(`export SHELL=${config.shell}\n`);
            stream.write(`export PS1=""\n`);
            stream.write(`cd ${config.cwd} && pwd\n`);

            // Wait for cd to complete before resolving
            let cdDone = false;
            const onData = (data: Buffer) => {
              if (!cdDone && data.toString('utf-8').includes(config.cwd)) {
                cdDone = true;
                stream.removeListener('data', onData);
                resolve(stream);
              }
            };
            stream.on('data', onData);
          },
        );
      });

      conn.connect(buildConnectionConfig(config));
    });
  }

  function exec(
    command: string,
    options: ExecOptions,
  ): Promise<ExecResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeout ?? 60000;
    let stdout = '';
    let stderr = '';
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let timedOut = false;
    let settled = false;

    return ensureSession().then((shell) => {
      return new Promise<ExecResult>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          timedOut = true;
          // Send Ctrl+C to interrupt the running command
          shell.write('\x03');

          setTimeout(() => {
            settled = true;
            resolvePromise({
              stdout,
              stderr,
              exitCode,
              signal: 'SIGINT',
              duration: Date.now() - startTime,
              timedOut: true,
              truncated: false,
            });
          }, 2000);
        }, timeoutMs);

        const onData = (data: Buffer) => {
          const text = data.toString('utf-8');

          // Split into lines and filter
          const lines = text.split('\n');
          for (const line of lines) {
            // Skip empty lines and our prompt marker
            if (line.includes(PROMPT)) {
              // Extract exit code from "EXIT_CODE=NN"
              const exitMatch = line.match(/EXIT_CODE=(\S+)/);
              if (exitMatch) {
                exitCode = parseInt(exitMatch[1], 10);
                if (isNaN(exitCode)) exitCode = null;
              }
              // Extract signal from "EXIT_SIGNAL=SIGINT"
              const signalMatch = line.match(/EXIT_SIGNAL=(\S+)/);
              if (signalMatch) {
                exitSignal = signalMatch[1];
              }
              continue;
            }
            if (line.trim() === '') continue;

            // Everything else is output (stdout or stderr mixed)
            stdout += line + '\n';
          }
        };

        const onClose = () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolvePromise({
              stdout,
              stderr,
              exitCode,
              signal: exitSignal,
              duration: Date.now() - startTime,
              timedOut,
              truncated: false,
            });
          }
        };

        const onErr = (err: Error) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            pendingError = err;
            rejectPromise(new Error(`SSH shell error: ${err.message}`));
          }
        };

        shell.on('data', onData);
        shell.on('close', onClose);
        shell.on('error', onErr);

        // Build the command with exit code capture wrapper
        const wrappedCommand = [
          `trap 'echo "EXIT_SIGNAL=$!"' INT TERM`,
          command,
          `echo "EXIT_CODE=$?"`,
          `echo "EXIT_SIGNAL=$!"`,
          `echo "${PROMPT}"`,
        ].join(' && ');

        // If stdin is provided, write it before the command
        if (options.stdin) {
          shell.write(options.stdin);
        }

        // Send the command
        shell.write(wrappedCommand + '\n');
      });
    });
  }

  function status(): Promise<StatusInfo> {
    return ensureSession().then((shell) => {
      return new Promise<StatusInfo>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('Status check timed out'));
        }, 10000);

        let collected = '';

        const onData = (data: Buffer) => {
          collected += data.toString('utf-8');
          // Look for the prompt marker indicating command finished
          if (collected.includes(PROMPT)) {
            clearTimeout(timer);
            shell.removeListener('data', onData);
            shell.removeListener('error', onErr);

            // Parse hostname from output
            const lines = collected.split('\n').filter((l) => l.trim());
            const hostname = lines[lines.length - 1]?.trim() || config.ssh.host;

            resolve({
              host: config.ssh.host,
              port: config.ssh.port,
              username: config.ssh.username,
              hostname,
              shell: config.shell,
              connected: true,
            });
          }
        };

        const onErr = (err: Error) => {
          clearTimeout(timer);
          reject(err);
        };

        shell.on('data', onData);
        shell.on('error', onErr);
        shell.write(`hostname && echo "${PROMPT}"\n`);
      });
    });
  }

  function destroy(): void {
    resetState();
  }

  return { exec, status, destroy };
}
