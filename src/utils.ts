/** Expand ~ to home directory in a path */
export function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return (process.env.HOME ?? '/') + p.slice(1);
  }
  return p;
}

/** Format duration in ms to a human-readable string */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

/** Parse comma-separated regex patterns into an array of RegExp */
export function parsePatterns(patterns: string): RegExp[] {
  return patterns
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      let flags = '';
      let body = s;
      // Handle inline flags like (?i), (?im), (?i)ALTER ROLE
      const flagMatch = body.match(/^\(\?([imxs]+)\)/);
      if (flagMatch) {
        flags = flagMatch[1];
        body = body.slice(flagMatch[0].length);
      }
      try {
        return new RegExp(body, flags);
      } catch (e) {
        throw new Error(
          `Invalid regex pattern "${s}": ${(e as Error).message}. ` +
          'Check for unbalanced parentheses, invalid character classes, or other regex syntax errors.',
        );
      }
    });
}

/** Truncate a string to maxChars, appending a notice */
export function truncateOutput(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text:
      text.slice(0, maxChars) +
      `\n\n[Output truncated: ${text.length} chars exceeds limit of ${maxChars}]\n`,
    truncated: true,
  };
}
