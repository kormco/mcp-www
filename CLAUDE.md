# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm install          # install dependencies
npm run build        # compile TypeScript (tsc) → dist/
npm run dev          # run in dev mode via ts-node
npm start            # run compiled server (dist/index.js)
```

No test or lint scripts are configured.

## Architecture

mcp-www is a single-file MCP server (`src/index.ts`, ~700 lines) that enables DNS-based MCP service discovery using UDP TXT lookups at `_mcp.{domain}`. It is both an MCP server itself (connected via stdio) and an MCP client (connecting to remote servers over Streamable HTTP).

**Dual role:** The server receives requests from agents via `StdioServerTransport`, then acts as a client by making raw `fetch`-based JSON-RPC calls to remote MCP servers. There is no SDK client usage — all remote communication is hand-rolled HTTP + JSON-RPC (initialize handshake → session ID → method calls).

**Flow layers in `src/index.ts`:**

1. **IDN Homograph Detection** — `detectHomograph()` checks for punycode, mixed-script, and non-Latin labels before any DNS lookup. Warnings are surfaced as separate content blocks, never blocking.
2. **DNS Lookup** — `lookupMcpDomain()` resolves `_mcp.{domain}` TXT records via `dns.resolveTxt()` (UDP). `parseMcpTxtRecord()` parses semicolon-delimited `key=value` pairs.
3. **Server Inspection** — `inspectMcpServer()` performs JSON-RPC `initialize` handshake, then parallel-fetches `tools/list`, `resources/list`, `prompts/list`.
4. **Remote Execution** — `callRemoteTool()`, `readRemoteResource()`, `getRemotePrompt()` each call `initRemoteServer()` for a fresh session, then `jsonRpcCall()` for the actual method.
5. **Tool Handlers** — 7 tools exposed: `browse_domain`, `browse_server`, `browse_multi`, `browse_discover`, `call_remote_tool`, `read_remote_resource`, `get_remote_prompt`.

**Key patterns:**
- Every remote operation creates a new session (no session reuse/pooling)
- `browse_discover` = DNS lookup + server inspection in one call
- Server `instructions` from remote servers are surfaced prominently so the model follows them
- DNS resolver can be overridden via `MCP_DNS_SERVER` env var (e.g., `MCP_DNS_SERVER=192.168.68.133:5335`)

**DNS TXT Record Format:** `v=mcp1; src=https://...; auth=oauth2; description=...`

**Key dependency:** `@modelcontextprotocol/sdk` (server-side only — used for `Server`, `StdioServerTransport`, and request schemas).
