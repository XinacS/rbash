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

const PROMPT = 'rbash-prompt-XYZ';
const OUTPUT_DELIM = 'rbash-output-start-XYZ';

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
  const maxConsecutiveErrors = config.maxConsecutiveErrors ?? 3;
  const idleTimeoutMs = config.idleTimeout ?? 0;

  let conn: Client | null = null;
  let shell: ClientChannel | null = null;
  let shellReady = false;
  let pendingError: Error | null = null;
  let consecutiveErrors = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  function markError(): void {
    consecutiveErrors++;
    if (consecutiveErrors >= maxConsecutiveErrors) {
      console.error(
        `[rbash] ${consecutiveErrors} consecutive errors, forcing reconnect`,
      );
      resetState();
      consecutiveErrors = 0;
    }
  }

  function markSuccess(): void {
    consecutiveErrors = 0;
    resetIdleTimer();
  }

  function resetIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (idleTimeoutMs > 0) {
      idleTimer = setTimeout(() => {
        console.error('[rbash] Idle timeout reached, closing connection');
        resetState();
      }, idleTimeoutMs);
    }
  }

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
    resetIdleTimer();
  }

  function ensureSession(): Promise<ClientChannel> {
    if (conn && shell && shellReady) {
      return Promise.resolve(shell);
    }

    resetState();

    return new Promise<ClientChannel>((resolve, reject) => {
      conn = new Client();

      const onError = (err: Error) => {
        markError();
        reject(new Error(`SSH connection error: ${err.message}`));
      };

      const onClose = () => {
        markError();
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
              markError();
              reject(new Error(`SSH shell error: ${err.message}`));
              return;
            }

            shell = stream;
            shellReady = true;

            // Set shell, disable prompt, and change to starting directory
            stream.write(`export SHELL=${config.shell}\n`);
            stream.write(`export PS1=""\n`);
            stream.write(`cd ${config.cwd} && pwd && echo "${PROMPT}"\n`);

            // Wait for cd to complete before resolving
            let cdDone = false;
            let cdTimeout: ReturnType<typeof setTimeout>;

            const onData = (data: Buffer) => {
              const text = data.toString('utf-8');
              if (!cdDone && text.includes(PROMPT)) {
                cdDone = true;
                clearTimeout(cdTimeout);
                stream.removeListener('data', onData);
                markSuccess();
                resolve(stream);
              }
            };
            stream.on('data', onData);

            cdTimeout = setTimeout(() => {
              if (!cdDone) {
                cdDone = true;
                stream.removeListener('data', onData);
                markError();
                reject(new Error('SSH shell initialization timed out'));
              }
            }, 10000);
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

          // Wait for the command to respond to Ctrl+C
          setTimeout(() => {
            settled = true;
            markError();
            // Reset the shell state to clear any pending data/ANSI codes
            // so the next command doesn't hang waiting for the PROMPT
            // from this timed-out command.
            resetState();
            resolvePromise({
              stdout,
              stderr,
              exitCode,
              signal: 'SIGINT',
              duration: Date.now() - startTime,
              timedOut: true,
              truncated: false,
            });
          }, 1000);
        }, timeoutMs);

        const onData = (data: Buffer) => {
          const text = data.toString('utf-8');

          // Split into lines and filter
          // Only split on \n to preserve \r in ANSI codes
          const lines = text.split('\n');
          for (const line of lines) {
            // Skip empty lines
            if (line.trim() === '') continue;

            // Strip ANSI escape sequences for cleaner output parsing
            const cleanLine = line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
            if (cleanLine === '') continue;

            // Extract exit code from "EXIT_CODE=NN"
            const exitMatch = cleanLine.match(/EXIT_CODE=(\S*)/);
            if (exitMatch) {
              if (exitMatch[1] !== '') {
                exitCode = parseInt(exitMatch[1], 10);
                if (isNaN(exitCode)) exitCode = null;
              }
              continue;
            }

            // Extract signal from "EXIT_SIGNAL=..." (skip empty signals)
            const signalMatch = cleanLine.match(/EXIT_SIGNAL=(.*)/);
            if (signalMatch) {
              if (signalMatch[1].trim() !== '') {
                exitSignal = signalMatch[1].trim();
              }
              continue;
            }

            // Check for prompt marker
            if (line.includes(PROMPT)) {
              // Command is complete, resolve the promise
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                markSuccess();
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
              continue;
            }

            // Everything else is output (stdout or stderr mixed)
            stdout += cleanLine + '\n';
          }
        };

        const onClose = () => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            markError();
            resetState();
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
            markError();
            rejectPromise(new Error(`SSH shell error: ${err.message}`));
          }
        };

        shell.on('data', onData);
        shell.on('close', onClose);
        shell.on('error', onErr);

        // Build the command with exit code capture wrapper.
        // Run the command in a subshell with stdin from /dev/null to prevent
        // hanging on interactive prompts. The exit code capture is outside the
        // subshell so it doesn't interfere with the command.
        const cwdPrefix = options.cwd ? `cd ${options.cwd} && ` : '';
        const wrappedCommand = `(${cwdPrefix}${command} < /dev/null); echo "EXIT_CODE=$?"; echo "EXIT_SIGNAL=$!"; echo "${PROMPT}"`;

        // Send the command
        shell.write(wrappedCommand + '\n');
      });
    }).catch((err) => {
      // Handle errors from ensureSession
      return {
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: null,
        signal: null,
        duration: Date.now() - startTime,
        timedOut: false,
        truncated: false,
      };
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
            markSuccess();

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
          markError();
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
