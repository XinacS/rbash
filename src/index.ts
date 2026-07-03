#!/usr/bin/env node

import { Command } from 'commander';
import type { ServerConfig, SshConfig } from './types.js';
import { parsePatterns, expandPath } from './utils.js';
import { startServer } from './server.js';

const program = new Command();

program
  .name('rbash')
  .description('MCP server for remote bash execution via SSH')
  .version('0.1.0')
  .option('--host <host>', 'Remote hostname or IP address')
  .option('--port <port>', 'SSH port', '22')
  .option('--user <user>', 'SSH username')
  .option('--key <path>', 'Path to SSH private key', '~/.ssh/id_rsa')
  .option('--passphrase <passphrase>', 'Passphrase for the private key')
  .option(
    '--password <password>',
    'Password for password-based authentication',
  )
  .option(
    '--timeout <ms>',
    'Default command timeout in milliseconds',
    '60000',
  )
  .option(
    '--maxChars <chars>',
    'Maximum output characters (0 = unlimited)',
    '100000',
  )
  .option('--whitelist <patterns>', 'Comma-separated regex allow list')
  .option('--blacklist <patterns>', 'Comma-separated regex deny list')
  .option('--cwd <dir>', 'Default working directory on remote', '~')
  .option('--shell <path>', 'Remote shell path', '/bin/bash')
  .option('--term <type>', 'Terminal type', 'xterm-256color');

program.parse(process.argv);

const opts = program.opts();

if (!opts.host) {
  console.error(
    'Error: --host is required (or set RBASH_HOST environment variable)',
  );
  process.exit(1);
}

if (!opts.user) {
  console.error(
    'Error: --user is required (or set RBASH_USER environment variable)',
  );
  process.exit(1);
}

if (!opts.key && !opts.password) {
  console.error(
    'Error: Provide either --key (default: ~/.ssh/id_rsa) or --password for authentication',
  );
  process.exit(1);
}

const sshConfig: SshConfig = {
  host: opts.host,
  port: parseInt(opts.port, 10),
  username: opts.user,
  keyPath: expandPath(opts.key),
  passphrase: opts.passphrase,
  password: opts.password,
};

const serverConfig: ServerConfig = {
  ssh: sshConfig,
  timeout: parseInt(opts.timeout, 10),
  maxChars: parseInt(opts.maxChars, 10),
  cwd: expandPath(opts.cwd),
  shell: opts.shell,
  term: opts.term,
  whitelist: opts.whitelist ? parsePatterns(opts.whitelist) : [],
  blacklist: opts.blacklist ? parsePatterns(opts.blacklist) : [],
};

startServer(serverConfig).catch((err) => {
  console.error('Fatal error starting rbash:', err);
  process.exit(1);
});
