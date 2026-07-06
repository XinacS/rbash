import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import type { ServerConfig } from './types.js';
import { createSshSession } from './ssh.js';
import { isCommandAllowed } from './filter.js';
import { truncateOutput } from './utils.js';

const DEFAULT_CWD = '~';

const BASH_DESCRIPTION = `Execute a shell command on the remote host via SSH.

IMPORTANT: Each call is STATELESS — a fresh SSH connection is opened and closed per command. Environment variables, exports, cd, aliases, etc. do NOT persist between calls. The default working directory is ${DEFAULT_CWD}. Use the 'cwd' parameter to run a command in a different directory, or include 'cd /path && command' in the command string.`;

export async function startServer(config: ServerConfig): Promise<void> {
  const server = new McpServer({
    name: 'rbash',
    version: '0.1.0',
  });

  // Create a session factory — each call gets its own session
  function makeSession() {
    return createSshSession(config);
  }

  server.registerTool(
    'bash',
    {
      description: BASH_DESCRIPTION,
      inputSchema: z.object({
        command: z
          .string()
          .describe('The shell command to execute on the remote host'),
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
            `Working directory on the remote host for this command. Default is ${DEFAULT_CWD}. Since each call is stateless, set this explicitly if the command needs a specific directory.`,
          ),
      }),
    },
    async (args) => {
      const { command, timeout, cwd } = args;

      const filterResult = isCommandAllowed(command, config);
      if (!filterResult.allowed) {
        return {
          content: [
            {
              type: 'text',
              text: `Command denied: ${filterResult.reason}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const sess = makeSession();
        const result = await sess.exec(command, {
          timeout: timeout ?? config.timeout,
          cwd: cwd ?? config.cwd,
        });

        const combinedOutput = result.stdout + result.stderr;
        const { text, truncated } = truncateOutput(
          combinedOutput,
          config.maxChars,
        );

        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            exitCode: result.exitCode,
            stderr: result.stderr,
            duration: result.duration,
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
              type: 'text',
              text: `Error executing command: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'sudo',
    {
      description:
        'Execute a command with sudo on the remote host via SSH. STATELESS — each call opens a fresh SSH connection. Runs non-interactively — if sudo requires a password, it will fail immediately rather than hanging. Use this for commands that need elevated privileges.',
      inputSchema: z.object({
        command: z
          .string()
          .describe('The shell command to execute with sudo on the remote host'),
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
            `Working directory on the remote host for this command. Default is ${DEFAULT_CWD}.`,
          ),
      }),
    },
    async (args) => {
      const { command, timeout, cwd } = args;

      const filterResult = isCommandAllowed(command, config);
      if (!filterResult.allowed) {
        return {
          content: [
            {
              type: 'text',
              text: `Command denied: ${filterResult.reason}`,
            },
          ],
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
                  type: 'text',
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
          content: [{ type: 'text', text }],
          structuredContent: {
            exitCode: result.exitCode,
            stderr: result.stderr,
            duration: result.duration,
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
              type: 'text',
              text: `Error executing sudo command: ${message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'bash-status',
    {
      description:
        'Test the SSH connection and return remote host information.',
      inputSchema: z
        .object({})
        .describe('No parameters required'),
    },
    async () => {
      try {
        const sess = makeSession();
        const info = await sess.status();
        const text = [
          `Connected to ${info.host}:${info.port} as ${info.username}`,
          `Hostname: ${info.hostname}`,
          `Shell: ${info.shell}`,
          `Status: online`,
        ].join('\n');
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            connected: true,
            host: info.host,
            port: info.port,
            username: info.username,
            hostname: info.hostname,
            shell: info.shell,
          },
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: `Connection failed: ${message}`,
            },
          ],
          structuredContent: {
            connected: false,
            error: message,
          },
          isError: true,
        };
      }
    },
  );

  const cleanup = () => {
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
