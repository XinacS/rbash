# rbash MCP Server - Compatibility Notes

## Known Compatibility Issues with Claude Code

### 1. Content Display
Claude Code's MCP client renders `structuredContent` as the visible JSON result of tool calls, while the `content` array (text output) is rendered separately. The command output IS present in `content[0].text` — it's just displayed differently than expected.

### 2. Stdio Framing
The MCP SDK (`@modelcontextprotocol/server@2.0.0-beta.2`) uses **newline-delimited JSON** for stdio transport. The MCP spec uses `Content-Length` framing. Claude Code uses the SDK's newline framing when connecting via stdio.

### 3. Console Output
**NEVER use `console.log()` in tool handlers** — stdout is the stdio transport channel. Writing to stdout corrupts the JSON-RPC message stream. Use `console.error()` for debug output (goes to stderr, separate from transport).

### 4. McpServer Constructor
The `McpServer` constructor does NOT accept `supportedProtocolVersions` — this property was incorrectly added and had no effect. Protocol version negotiation happens automatically via `serveStdio`.

### 5. Tool Handler Return Type
Tool handlers must return objects matching `CallToolResult`:
- `content`: array of content blocks with literal `type: 'text' as const`
- `structuredContent`: optional, any shape (z.ZodUnknown)
- `isError`: boolean

TypeScript requires `as const` on the `type` field to satisfy the literal type `"text"`.
