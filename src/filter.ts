import type { ServerConfig } from './types.js';

/**
 * Evaluate whether a command is allowed by the whitelist/blacklist rules.
 *
 * Rules:
 * - If whitelist is empty, all commands pass (unless blocked by blacklist).
 * - If whitelist is set, the command must match at least one pattern.
 * - If blacklist is set, the command must not match any pattern.
 * - Both can be combined: must pass whitelist AND not match blacklist.
 */
export function isCommandAllowed(
  command: string,
  config: ServerConfig,
): { allowed: boolean; reason?: string } {
  // Check blacklist first — if it matches, deny immediately
  for (const pattern of config.blacklist) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        reason: `Command matches blacklist pattern: ${pattern}`,
      };
    }
  }

  // If whitelist is set, command must match at least one pattern
  if (config.whitelist.length > 0) {
    for (const pattern of config.whitelist) {
      if (pattern.test(command)) {
        return { allowed: true };
      }
    }
    return {
      allowed: false,
      reason: `Command does not match any whitelist pattern: ${command}`,
    };
  }

  // No whitelist set — allow (blacklist already checked above)
  return { allowed: true };
}
