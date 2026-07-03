# rbash — Remote Bash MCP Server

An MCP (Model Context Protocol) server that gives AI agents the ability to execute bash commands on a remote Linux/Unix host via SSH — as if the commands were running locally.

rbash maintains a persistent SSH shell session, so commands like `cd`, `export`, and `source` work across calls. It streams stdout/stderr in real-time, supports stdin piping, handles long-running processes with configurable timeouts, and enforces command allow/deny lists for safety.

## Table of Contents

- [Architecture](#architecture)
- [Installation](#installation)
- [Configuration](#configuration)
  - [mcp.json (coding harness)](#mcpjson-coding-harness)
  - [Environment Variables](#environment-variables)
- [Authentication](#authentication)
  - [SSH Key with Passphrase](#ssh-key-with-passphrase)
  - [Password Authentication](#password-authentication)
- [Tools](#tools)
  - [bash](#bash)
  - [bash-status](#bash-status)
- [Command Filtering](#command-filtering)
- [Options Reference](#options-reference)
- [Examples](#examples)
- [Security Considerations](#security-considerations)
- [Development](#development)
- [License](#license)

## Architecture

```
┌──────────────────┐    stdio (JSON-RPC)     ┌─────────────────────┐    SSH      ┌─────────────────┐
│  MCP Client      │ ◄──────────────────────► │  rbash (Node.js)    │ ──────────► │  Remote Host    │
│  (opencode,      │                          │                     │             │  (Linux/Unix)   │
│   Claude Code,   │                          │  • Persistent SSH   │             └─────────────────┘
│   Cursor, etc.)  │                          │  • Shell session    │
└──────────────────┘                          │  • Command filter   │
                                              │  • Timeout/limits   │
                                              └─────────────────────┘
```

- **MCP Client**: Any MCP-compatible coding harness (opencode, Claude Code, Cursor, Windsurf, etc.)
- **rbash Server**: A Node.js process communicating over stdio using the MCP protocol
- **Remote Host**: The target Linux/Unix machine, connected via SSH with a persistent shell session

## Installation

```bash
npm install -g rbash
```

Or run directly without installation:

```bash
npx rbash --host example.com --user alice
```

## Configuration

### mcp.json (coding harness)

Add rbash to your coding harness's MCP configuration. Each CLI argument must be a separate array element:

```json
{
  "mcpServers": {
    "rbash": {
      "command": "npx",
      "args": ["-y", "rbash", "--host", "192.168.1.100", "--port", "22", "--user", "alice"]
    }
  }
}
```

Or with a local build:

```json
{
  "mcpServers": {
    "rbash": {
      "command": "./dist/index.js",
      "args": ["--host", "192.168.1.100", "--user", "alice"]
    }
  }
}
```

### Environment Variables

All CLI options can be set via environment variables instead:

| CLI Option | Environment Variable | Default |
|---|---|---|
| `--host` | `RBASH_HOST` | *(required)* |
| `--port` | `RBASH_PORT` | `22` |
| `--user` | `RBASH_USER` | *(required)* |
| `--key` | `RBASH_KEY` | `~/.ssh/id_rsa` |
| `--passphrase` | `RBASH_PASSPHRASE` | — |
| `--password` | `RBASH_PASSWORD` | — |
| `--timeout` | `RBASH_TIMEOUT` | `60000` |
| `--maxChars` | `RBASH_MAXCHARS` | `100000` |
| `--whitelist` | `RBASH_WHITELIST` | — |
| `--blacklist` | `RBASH_BLACKLIST` | — |

## Authentication

### SSH Key with Passphrase

The recommended authentication method. Provide the path to your private key and its passphrase:

```bash
rbash --host 192.168.1.100 --user alice --key ~/.ssh/id_ed25519 --passphrase mypassphrase
```

Or via environment variables:

```bash
export RBASH_HOST=192.168.1.100
export RBASH_USER=alice
export RBASH_KEY=~/.ssh/id_ed25519
export RBASH_PASSPHRASE=mypassphrase
npx rbash
```

### Password Authentication

Alternative to key-based auth. Provide username and password:

```bash
rbash --host 192.168.1.100 --user alice --password s3cret
```

Or via environment variables:

```bash
export RBASH_HOST=192.168.1.100
export RBASH_USER=alice
export RBASH_PASSWORD=s3cret
npx rbash
```

**Note:** Key-based auth is strongly recommended. Passwords are stored in process memory and should not be used in production environments.

## Tools

### bash

The primary tool for executing commands on the remote host. Maintains a persistent shell session across calls.

**Input Schema:**

```typescript
{
  // Required: The shell command to execute
  command: string;

  // Optional: Input to pipe to stdin
  stdin?: string;

  // Optional: Override default timeout in milliseconds (default: 60000)
  timeout?: number;

  // Optional: Working directory on remote (changes shell cwd)
  cwd?: string;
}
```

**Response:**

```typescript
{
  content: Array<{
    type: "text";
    text: string;           // Combined stdout + stderr output
  }>;

  structuredContent: {
    exitCode: number;       // Command exit code (0 = success)
    stdout: string;         // stdout only
    stderr: string;         // stderr only
    duration: number;       // Execution time in milliseconds
    timedOut: boolean;      // Whether the command was killed by timeout
    signal: string | null;  // Signal that killed the process, if any
    truncated: boolean;     // Whether output was truncated (maxChars exceeded)
  };

  isError: false;           // Non-zero exit codes are NOT errors
}
```

**Key behaviors:**

- **Persistent session**: Commands like `cd`, `export`, and `source` persist across calls. The shell session is maintained for the lifetime of the rbash process.
- **Non-zero exit codes are not errors**: Like real bash, a command returning exit code 1 is reported normally. The AI decides whether it constitutes an error.
- **Stderr included**: Both stdout and stderr are returned. This is intentional — the AI needs full visibility into command output (compiler warnings, debug output, etc.).
- **Timeout handling**: If a command exceeds the timeout, it is killed and the response includes `timedOut: true` with whatever output was produced before termination.
- **Output truncation**: If output exceeds `--maxChars`, it is truncated with a warning. The `truncated: true` flag indicates this happened.

**Examples:**

```json
// Simple command
{ "command": "ls -la /var/log" }

// With working directory
{ "command": "npm test", "cwd": "/home/alice/project" }

// Long-running command with extended timeout
{ "command": "npm run build", "timeout": 300000 }

// Piping input
{ "command": "wc -l", "stdin": "line1\nline2\nline3\nline4\nline5" }
```

### bash-status

Reports connection and remote system information. Useful for verifying connectivity and understanding the remote environment.

**Input Schema:**

```typescript
{
  // No input parameters required
}
```

**Response:**

```typescript
{
  content: Array<{
    type: "text";
    text: string;           // Human-readable status report
  }>;

  structuredContent: {
    connected: boolean;     // Whether SSH connection is active
    host: string;           // Remote hostname/IP
    port: number;           // SSH port
    user: string;           // SSH username
    remoteUser: string;     // Effective user on remote (whoami)
    remoteHost: string;     // Remote hostname (hostname)
    os: string;             // OS information (uname -s -r)
    uptime: string;         // System uptime
    cwd: string;            // Current working directory in shell session
    shell: string;          // Shell being used ($SHELL)
  };

  isError: false;
}
```

## Command Filtering

Command filtering prevents dangerous or unintended commands from being executed. Both whitelist and blacklist can be used simultaneously — a command must pass both checks.

### Whitelist

A comma-separated list of regular expressions. Only commands matching at least one pattern are allowed.

```bash
--whitelist "^ls( .*)?$,^cat .*,^df .*,^grep .*,^find .*,^pwd,^cd .*,^npm .*,^git .*,^curl .*,^ssh,^systemctl .*,^docker .*,^kubectl .*,^ps,^ss,^ip,^hostname,^uname,^whoami,^date,^head .*,^tail .*,^wc,^sort,^uniq,^tee,^mkdir,^cp,^mv,^rm,^chmod,^chown,^echo,^export,^source,^env,^man,^help"
```

### Blacklist

A comma-separated list of regular expressions. Commands matching any pattern are blocked, regardless of whitelist.

```bash
--blacklist "^rm -rf /,^shutdown,^reboot,^poweroff,^mkfs.*,^:(){ :|:& };:,^curl .* \| sh,^wget .* \| sh"
```

### Filter logic

1. If whitelist is configured, the command must match at least one whitelist pattern.
2. If blacklist is configured, the command must not match any blacklist pattern.
3. If neither is configured, all commands are allowed (not recommended for production).

**Example: whitelist-only (most restrictive)**

```bash
--whitelist "^ls,^cat .*,^df,^grep .*,^pwd,^cd .*,^npm .*,^git .*,^curl .*,^ssh,^systemctl .*,^docker .*,^kubectl .*,^ps,^ss,^ip,^hostname,^uname,^whoami,^date,^head .*,^tail .*,^wc,^sort,^uniq,^tee,^mkdir,^cp,^mv,^rm,^chmod,^chown,^echo,^export,^source,^env,^man,^help"
```

**Example: whitelist + blacklist (defense in depth)**

```bash
--whitelist "^ls,^cat .*,^df,^grep .*,^pwd,^cd .*,^npm .*,^git .*,^curl .*,^ssh,^systemctl .*,^docker .*,^kubectl .*,^ps,^ss,^ip,^hostname,^uname,^whoami,^date,^head .*,^tail .*,^wc,^sort,^uniq,^tee,^mkdir,^cp,^mv,^rm,^chmod,^chown,^echo,^export,^source,^env,^man,^help" \
--blacklist "^rm -rf /,^shutdown,^reboot,^poweroff"
```

## Options Reference

| Option | Env Var | Default | Description |
|---|---|---|---|
| `--host` | `RBASH_HOST` | *(required)* | Remote hostname or IP address |
| `--port` | `RBASH_PORT` | `22` | SSH port |
| `--user` | `RBASH_USER` | *(required)* | SSH username |
| `--key` | `RBASH_KEY` | `~/.ssh/id_rsa` | Path to private SSH key |
| `--passphrase` | `RBASH_PASSPHRASE` | — | Passphrase for the private key |
| `--password` | `RBASH_PASSWORD` | — | Password for password-based auth |
| `--timeout` | `RBASH_TIMEOUT` | `60000` | Default command timeout in milliseconds |
| `--maxChars` | `RBASH_MAXCHARS` | `100000` | Maximum output characters (0 = unlimited) |
| `--whitelist` | `RBASH_WHITELIST` | — | Comma-separated regex allow list |
| `--blacklist` | `RBASH_BLACKLIST` | — | Comma-separated regex deny list |
| `--cwd` | `RBASH_CWD` | `~` | Starting working directory on remote (cd on session start) |
| `--shell` | `RBASH_SHELL` | `/bin/bash` | Remote shell path |
| `--term` | `RBASH_TERM` | `xterm-256color` | Terminal type |
| `--version` | — | — | Show version and exit |
| `--help` | — | — | Show help and exit |
| `--cwd` | `RBASH_CWD` | `~` | Starting working directory on remote (cd on session start) |
| `--shell` | `RBASH_SHELL` | `/bin/bash` | Remote shell path |
| `--term` | `RBASH_TERM` | `xterm-256color` | Terminal type |

## Examples

### Basic usage with Claude Code

```bash
claude mcp add --transport stdio rbash -- \
  npx -y rbash --host 192.168.1.100 --user alice --key ~/.ssh/id_ed25519
```

Then ask: *"Run `df -h` on the remote server"* or *"Check if the nginx service is running"*.

### With command filtering (recommended for production)

```bash
claude mcp add --transport stdio rbash -- \
  npx -y rbash \
  --host prod-server.example.com \
  --user deploy \
  --key ~/.ssh/deploy_key \
  --whitelist "^ls( .*)?$,^cat .*,^df .*,^grep .*,^find .*,^pwd,^cd .*,^npm .*,^npx .*,^node .*,^git .*,^curl .*,^scp .*,^rsync .*,^ssh .*,^systemctl .*,^journalctl .*,^docker .*,^kubectl .*,^ps .*,^ss .*,^ip .*,^hostname .*,^uname .*,^whoami .*,^date .*,^head .*,^tail .*,^wc .*,^sort .*,^uniq .*,^tee .*,^mkdir .*,^cp .*,^mv .*,^rm .*,^chmod .*,^chown .*,^echo .*,^export .*,^source .*,^env .*,^printenv .*,^man .*,^help,^\.\.\/.*,^\.\/.*" \
  --blacklist "^rm -rf /,^shutdown,^reboot,^poweroff,^mkfs.*,^:(){ :|:& };:,^curl .* \| sh,^wget .* \| sh"
```

### With password auth via environment

```json
{
  "mcpServers": {
    "rbash": {
      "command": "rbash",
      "args": ["--host", "192.168.1.100", "--user", "alice"],
      "env": {
        "RBASH_PASSWORD": "s3cret",
        "RBASH_WHITELIST": "^ls,^cat .*,^df,^grep .*,^pwd,^cd .*,^npm .*,^git .*,^curl .*,^scp .*,^ssh,^systemctl .*,^docker .*,^kubectl .*,^ps,^ss,^ip,^hostname,^uname,^whoami,^date,^head .*,^tail .*,^wc,^sort,^uniq,^tee,^mkdir,^cp,^mv,^rm,^chmod,^chown,^echo,^export,^source,^env,^man,^help"
      }
    }
  }
}
```

### Long-running commands

```json
{ "command": "npm run build", "timeout": 300000 }
```

### Piping input

```json
{ "command": "wc -l", "stdin": "line1\nline2\nline3\nline4\nline5" }
```

## Security Considerations

1. **Command filtering is strongly recommended.** Without `--whitelist` or `--blacklist`, any command can be executed on the remote host. Use `--whitelist` to restrict to only the commands your AI agent needs.

2. **SSH credentials are managed locally.** The private key and password are loaded by rbash and never exposed to the AI model or transmitted over the network. They exist only in the rbash process memory.

3. **The SSH connection is encrypted.** All communication between rbash and the remote host uses SSH encryption.

4. **Timeouts prevent runaway processes.** The default 60-second timeout prevents commands from hanging indefinitely. Per-command timeouts can override this.

5. **MaxChars prevents output flooding.** The default 100,000 character limit prevents extremely large outputs from overwhelming the AI context window.

6. **No sudo by default.** rbash does not escalate privileges. If the SSH user has sudo access, it must be invoked explicitly within commands (e.g., `sudo systemctl restart nginx`).

7. **Single host per instance.** Each rbash instance connects to one remote host. For multiple hosts, run multiple instances with different names in your MCP config.

8. **Stderr is included in output.** Commands that write to stderr (e.g., compiler warnings, debug output) are included alongside stdout. This is intentional — the AI needs full visibility into command output.

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
git clone <repo-url>
cd rbash
npm install
npm run build
```

### Run locally (for testing)

```bash
npm run start -- --host 192.168.1.100 --user alice --key ~/.ssh/id_ed25519
```

### Run with MCP Inspector (debugging)

```bash
npx @modelcontextprotocol/inspector node dist/index.js --host 192.168.1.100 --user alice
```

### Project structure

```
rbash/
├── package.json        # Dependencies and build scripts
├── tsconfig.json       # TypeScript configuration
├── tsup.config.ts      # Build configuration
├── src/
│   ├── index.ts        # CLI entry point, arg parsing, server startup
│   ├── server.ts       # MCP server setup, tool registration
│   ├── ssh.ts          # SSH connection management (connect, shell, exec)
│   ├── filter.ts       # Command whitelist/blacklist logic
│   ├── types.ts        # Shared TypeScript types
│   └── utils.ts        # Helpers (expandPath, formatDuration, etc.)
└── README.md           # This file
```

### Building

```bash
npm run build    # Compile TypeScript to dist/
npm run clean    # Remove dist/
```

### Testing

```bash
npm test         # Run test suite
```

## License

MIT
