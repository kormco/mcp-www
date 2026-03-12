# mcp-www

[![npm version](https://img.shields.io/npm/v/mcp-www)](https://www.npmjs.com/package/mcp-www)
[![npm downloads](https://img.shields.io/npm/dm/mcp-www)](https://www.npmjs.com/package/mcp-www)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)

**Multi-mechanism MCP service discovery — DNS, llms.txt, server cards, and direct probing.**

## Problem

Agents need to discover MCP servers, but current approaches lean on centralized registries or hardcoded configurations. This creates single points of failure, adds deployment overhead, and forces agents into walled gardens. There should be a way to discover MCP services using infrastructure that already exists everywhere: DNS.

## How It Works

**mcp-www** is itself a standard MCP server. An agent connects to it the same way it connects to any other MCP server — no new client code, no special SDK, no registry signup.

Once connected, the agent calls the `browse_domain` tool with a domain name. mcp-www performs a standard **UDP DNS TXT lookup** for `_mcp.{domain}`, parses the semicolon-delimited record, and returns structured metadata about the MCP servers published by that domain.

```
Agent  →  mcp-www (MCP server)  →  UDP DNS query for _mcp.example.com TXT
                                    ←  "v=mcp1; src=https://mcp.example.com; ..."
       ←  Structured JSON response
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

🤖 Use your agent for easy `mcp-www` installation or follow the manual steps above.  Simply ask it to install mcp-www from npm (many clients require a restart for a new server.)

🚀 **Publish your own MCP server via _dns TXT record** - or -

**[korm.co](https://korm.co)** publishes a live `_mcp` TXT record. You can discover and interact with it end-to-end:

```
browse_all("korm.co")           → checks DNS, llms.txt, server card, and direct probe in one call
browse_discover("korm.co")      → discovers server via DNS, returns tools + resources + prompts
browse_server("https://mcp.korm.co")  → inspects tools, resources, and prompts
call_remote_tool("https://mcp.korm.co", "list_articles")  → returns blog articles
read_remote_resource("https://mcp.korm.co", "korm://bio")  → reads author bio
get_remote_prompt("https://mcp.korm.co", "recommend-post", { "topic": "AI" })  → gets prompt
```
⚠️ korm.co is a construction zone of new services so pardon any dust or temporary infra outages, thanks for your patience.


## Key Design Points

- **Uses UDP DNS (port 53) for lookups** — the lightest possible network primitive. No TCP handshake, no TLS negotiation, no HTTP overhead. A single UDP packet out, a single packet back.
- **The DNS infrastructure IS the registry** — no additional servers to deploy, no uptime to maintain, no accounts to create. If you can publish a TXT record, you can advertise your MCP server.
- **mcp-www is a standard MCP server** — any MCP-compliant agent can use it with zero new client code. It's just another server in your agent's config.
- **Supports the `_mcp` TXT record convention** — records follow a semicolon-delimited format:
  ```
  v=mcp1; src=https://mcp.example.com; auth=oauth2
  ```
- **Works with split-horizon DNS** — enterprise and private networks can publish internal `_mcp` records visible only inside their network, enabling private service discovery without exposing anything to the public internet.
- Allows overriding the default system DNS resolver via environment variable. Useful for benchmarking with a local resolver or pointing at a specific DNS infrastructure. MCP_DNS_SERVER=192.168.68.133:5335 npx mcp-www

## Tools Exposed

### `browse_discover`

Discover and inspect in one step. Looks up `_mcp.{domain}` TXT records, connects to the advertised server URL, and retrieves its full manifest — tools, resources, and prompts.

```json
{
  "tool": "browse_discover",
  "arguments": {
    "domain": "example.com"
  }
}
```

### `browse_all`

Comprehensive discovery across all known mechanisms for a single domain. Concurrently checks DNS TXT records (`_mcp.{domain}`), `llms.txt`, `.well-known/mcp.json` (server card), and direct MCP endpoint probing. Returns a unified response with results from each method.

```json
{
  "tool": "browse_all",
  "arguments": {
    "domain": "example.com"
  }
}
```

Returns:
```json
{
  "domain": "example.com",
  "dns": { "found": true, "record": {}, "server": {} },
  "llms_txt": "# Example\n...",
  "server_card": {},
  "direct": { "url": "https://mcp.example.com", "serverInfo": {} }
}
```

### `browse_domain`

Lookup `_mcp.{domain}` TXT records and return a parsed list of discovered MCP servers.

```json
{
  "tool": "browse_domain",
  "arguments": {
    "domain": "example.com"
  }
}
```

Returns structured server metadata: server URL, protocol version, auth requirements, and any additional fields published in the TXT record.



### `browse_server`

Given a discovered server URL, connect to it and retrieve its full manifest: tools, resources, and prompts. Lets the agent inspect what a discovered server actually offers before deciding to connect.

```json
{
  "tool": "browse_server",
  "arguments": {
    "url": "https://mcp.example.com"
  }
}
```

### `browse_multi`

Batch lookup across multiple domains in a single call. Useful for scanning a list of known domains or performing broad discovery.

```json
{
  "tool": "browse_multi",
  "arguments": {
    "domains": ["example.com", "acme.org", "internal.corp"]
  }
}
```

### `call_remote_tool`

Call a tool on a remote MCP server. Use `browse_server` first to discover available tools, then use this to execute them. Handles the JSON-RPC initialize handshake and `tools/call` request.

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

Read a resource from a remote MCP server. Use `browse_server` or `browse_discover` first to see available resources, then use this to read one by its URI.

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

Get a prompt from a remote MCP server. Use `browse_server` or `browse_discover` first to see available prompts, then use this to retrieve one with optional arguments.

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


## Status

**Working.** The server implements DNS-based discovery, server inspection, remote tool calling, resource reading, and prompt retrieval over the Streamable HTTP transport.

Feedback, criticism, and alternative approaches are welcome — open an issue or start a discussion.

## Security

### DNS-based trust model

Because mcp-www uses DNS TXT records for discovery, domain ownership is enforced by DNS infrastructure itself — only the domain owner (or their DNS provider) can publish `_mcp` TXT records. This is inherently stronger than centralized registries, which introduce a single point of compromise.

### IDN homograph attack detection

mcp-www detects [IDN homograph attacks](https://en.wikipedia.org/wiki/IDN_homograph_attack) on all domain lookups. These attacks use visually identical characters from different Unicode scripts (e.g., Cyrillic "а" vs Latin "a") to spoof legitimate domains. For example, `xn--80ak6aa92e.com` renders as `apple.com` but resolves to an attacker-controlled server.

Detection covers:
- **Punycode-encoded domains** — labels starting with `xn--` (the ASCII encoding of internationalized domain names)
- **Mixed-script labels** — a single label containing characters from multiple scripts (e.g., Latin + Cyrillic)
- **Non-Latin labels** — fully Cyrillic/Greek labels that could visually mimic common Latin domains

When detected, a prominent warning is surfaced as a separate content block in the tool response, instructing the agent to verify the domain with the user before proceeding. Lookups are not blocked — the warning is informational, giving the agent and user the context to make an informed decision.

### Additional considerations

- **No implicit trust** — mcp-www discovers and inspects remote servers, but tool execution (`call_remote_tool`) is always an explicit agent action. The agent must choose to call a tool after reviewing the server manifest. Typical MCP initialization discovers tools when MCP servers are configured, not at runtime requiring agents to reason about remote tool invocation.
- **Split-horizon DNS** — private/internal `_mcp` records are only resolvable within the network they're published on, preventing accidental exposure of internal services.
- **Unicode normalization** — all domain inputs are NFC-normalized before lookup to prevent equivalent-but-different Unicode representations from bypassing detection.

## Related

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification)
- [DNS TXT records for organisation-scoped registry discovery](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2334) — Discussion #2334
- [DNS-native MCP discovery: a zero-infrastructure alternative](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2368) — Discussion #2368
- [SEP-2127: MCP Server Cards — HTTP Server Discovery via .well-known](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127)

## License

MIT
