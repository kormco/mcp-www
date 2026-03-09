# mcp-browse

**DNS-based MCP service discovery over UDP.**

## Problem

Agents need to discover MCP servers, but current approaches lean on centralized registries or hardcoded configurations. This creates single points of failure, adds deployment overhead, and forces agents into walled gardens. There should be a way to discover MCP services using infrastructure that already exists everywhere: DNS.

## How It Works

**mcp-browse** is itself a standard MCP server. An agent connects to it the same way it connects to any other MCP server — no new client code, no special SDK, no registry signup.

Once connected, the agent calls the `browse_domain` tool with a domain name. mcp-browse performs a standard **UDP DNS TXT lookup** for `_mcp.{domain}`, parses the semicolon-delimited record, and returns structured metadata about the MCP servers published by that domain.

```
Agent  →  mcp-browse (MCP server)  →  UDP DNS query for _mcp.example.com TXT
                                    ←  "v=mcp1; src=https://mcp.example.com; ..."
       ←  Structured JSON response
```

No HTTP registry in the loop. The DNS infrastructure **is** the registry.

## Key Design Points

- **Uses UDP DNS (port 53) for lookups** — the lightest possible network primitive. No TCP handshake, no TLS negotiation, no HTTP overhead. A single UDP packet out, a single packet back.
- **The DNS infrastructure IS the registry** — no additional servers to deploy, no uptime to maintain, no accounts to create. If you can publish a TXT record, you can advertise your MCP server.
- **mcp-browse is a standard MCP server** — any MCP-compliant agent can use it with zero new client code. It's just another server in your agent's config.
- **Supports the `_mcp` TXT record convention** — records follow a semicolon-delimited format:
  ```
  v=mcp1; src=https://mcp.example.com; public=true; auth=oauth2; version=2024.1
  ```
- **Works with split-horizon DNS** — enterprise and private networks can publish internal `_mcp` records visible only inside their network, enabling private service discovery without exposing anything to the public internet.

## Tools Exposed

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

## Try It

**[korm.co](https://korm.co)** publishes a live `_mcp` TXT record. You can discover and interact with it end-to-end:

```
browse_discover("korm.co")      → discovers server, returns tools + resources + prompts
browse_server("https://mcp.korm.co")  → inspects tools, resources, and prompts
call_remote_tool("https://mcp.korm.co", "list_articles")  → returns blog articles
read_remote_resource("https://mcp.korm.co", "korm://bio")  → reads author bio
get_remote_prompt("https://mcp.korm.co", "recommend-post", { "topic": "AI" })  → gets prompt
```

## Status

**Working.** The server implements DNS-based discovery, server inspection, remote tool calling, resource reading, and prompt retrieval over the Streamable HTTP transport.

Feedback, criticism, and alternative approaches are welcome — open an issue or start a discussion.

## Related

- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io)
- [MCP Discussion #2334](https://github.com/modelcontextprotocol/specification/discussions/2334)
- [MCP PR #2127](https://github.com/modelcontextprotocol/specification/pull/2127)
- [MCP SEP #1959](https://github.com/nicobailon/mcp-seps/blob/main/SEP/1959/README.md)

## License

MIT
