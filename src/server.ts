import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';
import type { ServerConfig } from './types.js';
import { createSshSession, type SshSession } from './ssh.js';
import { isCommandAllowed } from './filter.js';
import { truncateOutput } from './utils.js';

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
        stdin: z
          .string()
          .optional()
          .describe('Optional input to pipe to the command stdin'),
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
      const { command, stdin, timeout, cwd } = args;

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
          stdin,
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
