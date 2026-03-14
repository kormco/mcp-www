# mcp-www

[![npm version](https://img.shields.io/npm/v/mcp-www)](https://www.npmjs.com/package/mcp-www)
[![npm downloads](https://img.shields.io/npm/dm/mcp-www)](https://www.npmjs.com/package/mcp-www)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**DNS-based MCP service discovery and installation.**

## Problem

Agents need to discover MCP servers, but current approaches lean on centralized registries or hardcoded configurations. This creates single points of failure, adds deployment overhead, and forces agents into walled gardens. There should be a way to discover MCP services using infrastructure that already exists everywhere: DNS.

## How It Works

**mcp-www** is itself a standard MCP server. An agent connects to it the same way it connects to any other MCP server — no new client code, no special SDK, no registry signup.

Once connected, the agent calls `discover` with a domain name. mcp-www performs a standard **UDP DNS TXT lookup** for `_mcp.{domain}`, parses the records, and returns all advertised MCP servers. Then `browse` connects to those servers and retrieves their full manifests. Finally, `install` generates the config to permanently add a server to the user's MCP client.

```
Agent  →  mcp-www  →  discover("example.com")  →  DNS TXT lookup
                   →  browse("example.com")     →  parallel server card + MCP handshake
                   →  install("example.com")    →  config for Claude Desktop / VS Code / Cursor / Windsurf
```

No HTTP registry in the loop. The DNS infrastructure **is** the registry.

## Install

```bash
npm install -g mcp-www
```

Or use directly with `npx`:

```bash
npx mcp-www
```

### Claude Code / MCP Client Config

Add to your MCP client config (e.g., `.mcp.json`):

```json
{
  "mcpServers": {
    "mcp-www": {
      "type": "stdio",
      "command": "npx",
      "args": ["mcp-www"]
    }
  }
}
```

## Try It

**[korm.co](https://korm.co)** publishes a live `_mcp` TXT record. You can discover and interact with it end-to-end:

```
discover("korm.co")           → DNS lookup, returns all _mcp TXT records
browse({ domain: "korm.co" }) → parallel server card + MCP handshake, full manifest
call_remote_tool("https://mcp.korm.co", "browse_posts")  → returns blog articles
read_remote_resource("https://mcp.korm.co", "korm://bio") → reads author bio
get_remote_prompt("https://mcp.korm.co", "recommend-post", { "topic": "AI" }) → gets prompt
install({ domain: "korm.co" }) → generates config to add to your MCP client
```

## Key Design Points

- **Uses UDP DNS (port 53) for lookups** — the lightest possible network primitive. A single UDP packet out, a single packet back.
- **The DNS infrastructure IS the registry** — no additional servers to deploy, no uptime to maintain, no accounts to create. If you can publish a TXT record, you can advertise your MCP server.
- **mcp-www is a standard MCP server** — any MCP-compliant agent can use it with zero new client code.
- **Multiple TXT records supported** — a domain can advertise multiple MCP servers via separate `_mcp` TXT records.
- **Supports the `_mcp` TXT record convention:**
  ```
  v=mcp1; src=https://mcp.example.com; auth=oauth2
  ```
- **Works with split-horizon DNS** — enterprise and private networks can publish internal `_mcp` records visible only inside their network.
- Allows overriding the default system DNS resolver via environment variable: `MCP_DNS_SERVER=192.168.68.133:5335 npx mcp-www`

## Tools

### `discover`

DNS-only lookup. Returns all `_mcp.{domain}` TXT records — there can be multiple, each advertising a different MCP server. Supports single domain or batch lookup.

```json
{ "tool": "discover", "arguments": { "domain": "example.com" } }
{ "tool": "discover", "arguments": { "domains": ["example.com", "acme.org"] } }
```

### `browse`

Connect and inspect. Takes a domain or server URL. For domains: parallel fetch of `.well-known/mcp.json` (server card) and MCP initialize handshake on all DNS-advertised servers. Returns full server manifest (tools, resources, prompts).

```json
{ "tool": "browse", "arguments": { "domain": "example.com" } }
{ "tool": "browse", "arguments": { "url": "https://mcp.example.com" } }
```

### `call_remote_tool`

Call a tool on a remote MCP server. Use `browse` first to discover available tools, then use this to execute them.

```json
{
  "tool": "call_remote_tool",
  "arguments": {
    "url": "https://mcp.example.com",
    "tool": "list_articles",
    "arguments": { "limit": 5 }
  }
}
```

### `read_remote_resource`

Read a resource from a remote MCP server by its URI.

```json
{
  "tool": "read_remote_resource",
  "arguments": {
    "url": "https://mcp.example.com",
    "uri": "korm://bio"
  }
}
```

### `get_remote_prompt`

Get a prompt from a remote MCP server with optional arguments.

```json
{
  "tool": "get_remote_prompt",
  "arguments": {
    "url": "https://mcp.example.com",
    "prompt": "recommend-post",
    "arguments": { "topic": "AI vision" }
  }
}
```

### `install`

Generate client configuration to permanently add a discovered MCP server. Returns config file paths and JSON entries for Claude Desktop, VS Code, Cursor, and Windsurf. The agent reads the target config file, merges the entry, and writes it back.

```json
{ "tool": "install", "arguments": { "domain": "example.com" } }
{ "tool": "install", "arguments": { "url": "https://mcp.example.com", "name": "my-server" } }
```

## Status

**Working.** The server implements DNS-based discovery, server inspection, remote tool calling, resource reading, prompt retrieval, and client installation over the Streamable HTTP transport.

Feedback, criticism, and alternative approaches are welcome — open an issue or start a discussion.

## Security

### DNS-based trust model

Because mcp-www uses DNS TXT records for discovery, domain ownership is enforced by DNS infrastructure itself — only the domain owner (or their DNS provider) can publish `_mcp` TXT records. This is inherently stronger than centralized registries, which introduce a single point of compromise.

### IDN homograph attack detection

mcp-www detects [IDN homograph attacks](https://en.wikipedia.org/wiki/IDN_homograph_attack) on all domain lookups. These attacks use visually identical characters from different Unicode scripts (e.g., Cyrillic "a" vs Latin "a") to spoof legitimate domains.

Detection covers:
- **Punycode-encoded domains** — labels starting with `xn--` (the ASCII encoding of internationalized domain names)
- **Mixed-script labels** — a single label containing characters from multiple scripts (e.g., Latin + Cyrillic)
- **Non-Latin labels** — fully Cyrillic/Greek labels that could visually mimic common Latin domains

When detected, a prominent warning is surfaced as a separate content block, instructing the agent to verify the domain with the user before proceeding. Lookups are not blocked — the warning is informational.

### Additional considerations

- **No implicit trust** — mcp-www discovers and inspects remote servers, but tool execution (`call_remote_tool`) is always an explicit agent action.
- **Split-horizon DNS** — private/internal `_mcp` records are only resolvable within the network they're published on.
- **Unicode normalization** — all domain inputs are NFC-normalized before lookup.

## Related

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification)
- [DNS TXT records for organisation-scoped registry discovery](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2334) — Discussion #2334
- [DNS-native MCP discovery: a zero-infrastructure alternative](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2368) — Discussion #2368
- [SEP-2127: MCP Server Cards — HTTP Server Discovery via .well-known](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127)

## License

MIT
