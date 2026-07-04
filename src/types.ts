/** SSH connection configuration */
export interface SshConfig {
  host: string;
  port: number;
  username: string;
  /** Path to private key file (for key auth) */
  keyPath?: string;
  /** Passphrase for the private key */
  passphrase?: string;
  /** Password (for password auth) */
  password?: string;
}

/** Server-wide configuration */
export interface ServerConfig {
  ssh: SshConfig;
  /** Default timeout in ms */
  timeout: number;
  /** Max output characters (0 = unlimited) */
  maxChars: number;
  /** Default working directory on remote */
  cwd: string;
  /** Remote shell path */
  shell: string;
  /** Terminal type */
  term: string;
  /** Command whitelist regexes */
  whitelist: RegExp[];
  /** Command blacklist regexes */
  blacklist: RegExp[];
  /** Max consecutive errors before forcing reconnect (default: 3) */
  maxConsecutiveErrors?: number;
  /** Idle timeout in ms — close connection if no commands for this duration (0 = disabled, default: 0) */
  idleTimeout?: number;
}

/** Result of executing a command on the remote host */
export interface ExecResult {
  /** stdout output */
  stdout: string;
  /** stderr output */
  stderr: string;
  /** Exit code (null if killed by signal) */
  exitCode: number | null;
  /** Signal that killed the process (if applicable) */
  signal: string | null;
  /** Execution duration in ms */
  duration: number;
  /** Whether the command timed out */
  timedOut: boolean;
  /** Whether output was truncated due to maxChars */
  truncated: boolean;
}

/** Input parameters for the bash tool */
export interface BashToolInput {
  /** The shell command to execute */
  command: string;
  /** Per-command timeout override in ms (0 = use default) */
  timeout?: number;
  /** Working directory for this command on remote */
  cwd?: string;
}

/** MCP tool result structure */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: {
    exitCode: number | null;
    stderr: string;
    duration: number;
    timedOut: boolean;
    truncated: boolean;
    signal: string | null;
  };
  isError: boolean;
}
