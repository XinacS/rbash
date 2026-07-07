import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { ServerConfig } from './types.js';
import { createSshSession } from './ssh.js';
import { isCommandAllowed } from './filter.js';
import { truncateOutput } from './utils.js';
import { StdioServerTransport } from './stdio-claude.js';

const DEFAULT_CWD = '~';

const BASH_DESCRIPTION = `Execute a shell command on the remote server via SSH.

IMPORTANT: This runs commands on the REMOTE SERVER, NOT locally. Each call is STATELESS — a fresh SSH connection is opened and closed per command. Environment variables, exports, cd, aliases, etc. do NOT persist between calls. The default working directory is ${DEFAULT_CWD}. Use the 'cwd' parameter to run a command in a different directory, or include 'cd /path && command' in the command string.`;

export async function startServer(config: ServerConfig): Promise<void> {
  // Factory function for serveStdio
  const factory = () => {
    const server = new McpServer({
      name: 'rbash',
      version: '0.1.0',
    });

    // Create a session factory — each call gets its own session
    function makeSession() {
      return createSshSession(config);
    }

    server.registerTool(
      'remote-bash',
      {
        description: BASH_DESCRIPTION,
        inputSchema: z.object({
          command: z
            .string()
            .describe('The shell command to execute on the remote server via SSH'),
          timeout: z
            .number()
            .optional()
            .describe(
              'Per-command timeout in milliseconds (0 uses server default)',
            ),
          cwd: z
            .string()
            .optional()
            .describe(
              `Working directory on the remote server for this command. Default is ${DEFAULT_CWD}. Since each call is stateless, set this explicitly if the command needs a specific directory.`,
            ),
        }),
      },
      async (args) => {
        const { command, timeout, cwd } = args;
        const startTime = Date.now();

        const filterResult = isCommandAllowed(command, config);
        if (!filterResult.allowed) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Command denied: ${filterResult.reason}`,
              },
            ],
            structuredContent: {
              exitCode: null,
              stderr: '',
              stdout: '',
              duration: Date.now() - startTime,
              timedOut: false,
              truncated: false,
              signal: null,
              denied: true,
              denyReason: filterResult.reason,
            },
            isError: true,
          };
        }

        try {
          const sess = makeSession();
          const result = await sess.exec(command, {
            timeout: timeout ?? config.timeout,
            cwd: cwd ?? config.cwd,
          });
          const duration = Date.now() - startTime;

          const combinedOutput = result.stdout + result.stderr;
          const { text, truncated } = truncateOutput(
            combinedOutput,
            config.maxChars,
          );

          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: {
              exitCode: result.exitCode,
              stderr: result.stderr,
              stdout: result.stdout,
              duration: result.duration,
              commandDuration: duration,
              timedOut: result.timedOut,
              truncated: truncated || result.truncated,
              signal: result.signal,
              cwdUsed: cwd ?? config.cwd,
              stdoutLength: result.stdout.length,
              stderrLength: result.stderr.length,
              maxChars: config.maxChars,
            },
            isError: false,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const duration = Date.now() - startTime;
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error executing command: ${message}`,
              },
            ],
            structuredContent: {
              exitCode: null,
              stderr: '',
              stdout: '',
              duration: duration,
              timedOut: false,
              truncated: false,
              signal: null,
              error: message,
              errorType: err instanceof Error ? err.constructor.name : typeof err,
            },
            isError: true,
          };
        }
      },
    );

    server.registerTool(
      'remote-sudo',
      {
        description:
          'Execute a command with sudo on the remote server via SSH. STATELESS — each call opens a fresh SSH connection. Runs non-interactively — if sudo requires a password, it will fail immediately rather than hanging. Use this for commands that need elevated privileges on the remote server.',
        inputSchema: z.object({
          command: z
            .string()
            .describe('The shell command to execute with sudo on the remote server via SSH'),
          timeout: z
            .number()
            .optional()
            .describe(
              'Per-command timeout in milliseconds (0 uses server default)',
            ),
          cwd: z
            .string()
            .optional()
            .describe(
              `Working directory on the remote server for this command. Default is ${DEFAULT_CWD}.`,
            ),
        }),
      },
      async (args) => {
        const { command, timeout, cwd } = args;
        const startTime = Date.now();

        const filterResult = isCommandAllowed(command, config);
        if (!filterResult.allowed) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Command denied: ${filterResult.reason}`,
              },
            ],
            structuredContent: {
              exitCode: null,
              stderr: '',
              duration: Date.now() - startTime,
              timedOut: false,
              truncated: false,
              signal: null,
              denied: true,
              denyReason: filterResult.reason,
            },
            isError: true,
          };
        }

        const sudoCommand = `sudo -n ${command}`;

        try {
          const sess = makeSession();
          const result = await sess.exec(sudoCommand, {
            timeout: timeout ?? config.timeout,
            cwd: cwd ?? config.cwd,
          });

          const combinedOutput = result.stdout + result.stderr;
          const { text, truncated } = truncateOutput(
            combinedOutput,
            config.maxChars,
          );

          if (result.exitCode !== null && result.exitCode !== 0) {
            const stderr = result.stderr || '';
            if (
              stderr.includes('no tty present') ||
              stderr.includes('a password is required') ||
              stderr.includes('Sorry, try again')
            ) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `sudo failed: ${stderr.trim() || `command exited with code ${result.exitCode}`}. The sudo configuration on the remote host does not allow passwordless sudo for this command. Configure sudoers to allow passwordless execution, or run the command without sudo.`,
                  },
                ],
                structuredContent: {
                  exitCode: result.exitCode,
                  stderr: result.stderr,
                  duration: result.duration,
                  timedOut: result.timedOut,
                  truncated: truncated || result.truncated,
                  signal: result.signal,
                  sudoRequiresPassword: true,
                },
                isError: true,
              };
            }
          }

          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: {
              exitCode: result.exitCode,
              stderr: result.stderr,
              duration: result.duration,
              commandDuration: Date.now() - startTime,
              timedOut: result.timedOut,
              truncated: truncated || result.truncated,
              signal: result.signal,
            },
            isError: false,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error executing sudo command: ${message}`,
              },
            ],
            structuredContent: {
              exitCode: null,
              stderr: '',
              duration: Date.now() - startTime,
              timedOut: false,
              truncated: false,
              signal: null,
              error: message,
            },
            isError: true,
          };
        }
      },
    );

    server.registerTool(
      'remote-bash-status',
      {
        description:
          'Test the SSH connection to the remote server and return remote host information.',
        inputSchema: z
          .object({})
          .describe('No parameters required'),
      },
      async () => {
        const startTime = Date.now();
        try {
          const sess = makeSession();
          const info = await sess.status();
          const duration = Date.now() - startTime;

          const text = [
            `Connected to ${info.host}:${info.port} as ${info.username}`,
            `Hostname: ${info.hostname}`,
            `Shell: ${info.shell}`,
            `Status: online`,
          ].join('\n');
          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: {
              connected: true,
              host: info.host,
              port: info.port,
              username: info.username,
              hostname: info.hostname,
              shell: info.shell,
              duration: duration,
            },
            isError: false,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const duration = Date.now() - startTime;
          return {
            content: [
              {
                type: 'text' as const,
                text: `Connection failed: ${message}`,
              },
            ],
            structuredContent: {
              connected: false,
              error: message,
              duration: duration,
            },
            isError: true,
          };
        }
      },
    );

    return server;
  };

  const cleanup = () => {
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Use custom stdio transport that supports Content-Length framing (Claude Code)
  // and newline framing (SDK default)
  const transport = new StdioServerTransport();
  const server = factory();
  // server.connect() internally calls transport.start()
  await server.connect(transport);
}
