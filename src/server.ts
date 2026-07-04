import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import type { ServerConfig } from './types.js';
import { createSshSession, type SshSession } from './ssh.js';
import { isCommandAllowed } from './filter.js';
import { truncateOutput } from './utils.js';

/**
 * Sudo tool: executes a command with sudo on the remote host.
 *
 * Design: commands are run non-interactively (stdin from /dev/null).
 * If sudo requires a password, it will receive EOF and fail immediately
 * rather than hanging waiting for user input. This prevents the common
 * timeout scenario where sudo prompts for a password and the connection
 * appears to hang.
 */
function createSudoTool(config: ServerConfig, getSession: () => SshSession) {
  return {
    name: 'sudo',
    description:
      'Execute a command with sudo on the remote host. Runs non-interactively — if sudo requires a password, it will fail immediately rather than hanging. Use this for commands that need elevated privileges.',
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
        .describe('Working directory on the remote host for this command'),
    }),
    handler: async (args: {
      command: string;
      timeout?: number;
      cwd?: string;
    }) => {
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

      // Wrap the command with sudo -n (non-interactive, no password prompt)
      const sudoCommand = `sudo -n ${command}`;

      try {
        const sess = getSession();
        const result = await sess.exec(sudoCommand, {
          timeout: timeout ?? config.timeout,
          cwd,
        });

        const { text, truncated } = truncateOutput(
          result.stdout,
          config.maxChars,
        );

        // If sudo failed because it can't run non-interactively (no password
        // configured or sudoers requires tty), provide a helpful error
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
  };
}

export async function startServer(config: ServerConfig): Promise<void> {
  const server = new McpServer({
    name: 'rbash',
    version: '0.1.0',
  });

  let session: SshSession | null = null;

  function getSession(): SshSession {
    if (!session) {
      session = createSshSession(config);
    }
    return session;
  }

  server.registerTool(
    'bash',
    {
      description:
        'Execute a shell command on the remote host via SSH. Commands run in a persistent shell session, so cd, export, and source persist across calls.',
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
          .describe('Working directory on the remote host for this command'),
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
        const sess = getSession();
        const result = await sess.exec(command, {
          timeout: timeout ?? config.timeout,
          cwd,
        });

        const { text, truncated } = truncateOutput(
          result.stdout,
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

  // Register sudo tool
  const sudoTool = createSudoTool(config, getSession);
  server.registerTool(
    sudoTool.name,
    {
      description: sudoTool.description,
      inputSchema: sudoTool.inputSchema,
    },
    sudoTool.handler,
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
        const sess = getSession();
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
    if (session) {
      session.destroy();
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
