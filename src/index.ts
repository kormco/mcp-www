/**
 * mcp-browse
 *
 * A lightweight MCP server that performs DNS-based discovery of MCP services
 * using UDP lookups. No registry server needed.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import dns from "node:dns";
import { promisify } from "node:util";

const resolveTxt = promisify(dns.resolveTxt);

// --- TXT Record Parser ---
function parseMcpTxtRecord(txtRecords: string[][]): Record<string, string> {
  // TXT records come as arrays of strings (chunked), join them
  const fullRecord = txtRecords.map((chunks) => chunks.join("")).join("");

  const result: Record<string, string> = {};

  // Parse semicolon-delimited key=value pairs
  // e.g. "v=mcp1; endpoint=https://...; public=true"
  const pairs = fullRecord.split(";").map((s) => s.trim()).filter(Boolean);

  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      result[key] = value;
    }
  }

  return result;
}

// --- DNS Lookup ---
async function lookupMcpDomain(domain: string): Promise<Record<string, string> | null> {
  const mcpDomain = `_mcp.${domain}`;

  try {
    const records = await resolveTxt(mcpDomain);
    if (records.length === 0) {
      return null;
    }
    return parseMcpTxtRecord(records);
  } catch (err: any) {
    if (err.code === "ENODATA" || err.code === "ENOTFOUND") {
      return null; // No TXT record found
    }
    throw err;
  }
}

// --- MCP Server Inspection ---
async function inspectMcpServer(url: string): Promise<any> {
  // Initialize handshake
  const initResponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-browse", version: "0.1.0" },
      },
    }),
  });

  if (!initResponse.ok) {
    throw new Error(`Server returned ${initResponse.status}`);
  }

  const initResult = await initResponse.json();

  const jsonRpcPost = (id: number, method: string) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }),
    }).then(async (r) => (r.ok ? (await r.json()).result : null));

  const [toolsResult, resourcesResult, promptsResult] = await Promise.all([
    jsonRpcPost(2, "tools/list"),
    jsonRpcPost(3, "resources/list").catch(() => null),
    jsonRpcPost(4, "prompts/list").catch(() => null),
  ]);

  return {
    serverInfo: initResult.result?.serverInfo || null,
    protocolVersion: initResult.result?.protocolVersion || null,
    instructions: initResult.result?.instructions || null,
    tools: toolsResult?.tools || [],
    resources: resourcesResult?.resources || [],
    prompts: promptsResult?.prompts || [],
  };
}

// --- Combined Discovery + Inspection ---
async function discoverMcpDomain(domain: string): Promise<any> {
  const record = await lookupMcpDomain(domain);
  if (record === null) {
    return { domain, found: false, message: `No _mcp.${domain} TXT record found` };
  }

  const serverUrl = record.src || record.endpoint;
  if (!serverUrl) {
    return { domain, found: true, record, server: null, message: "No server URL (src/endpoint) in TXT record" };
  }

  try {
    const serverInfo = await inspectMcpServer(serverUrl);
    return { domain, found: true, record, server: { url: serverUrl, ...serverInfo } };
  } catch (err: any) {
    return { domain, found: true, record, server: { url: serverUrl, error: err.message } };
  }
}

// --- Remote Server Helpers ---
async function initRemoteServer(url: string): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-browse", version: "0.1.0" },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status} during initialization`);
  }
}

async function jsonRpcCall(url: string, id: number, method: string, params: Record<string, unknown>): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status} during ${method}`);
  }

  const result = await response.json();

  if (result.error) {
    throw new Error(result.error.message || JSON.stringify(result.error));
  }

  return result.result;
}

// --- Remote Tool Calling ---
async function callRemoteTool(
  url: string,
  toolName: string,
  toolArgs: Record<string, unknown> = {}
): Promise<any> {
  await initRemoteServer(url);
  return jsonRpcCall(url, 2, "tools/call", { name: toolName, arguments: toolArgs });
}

// --- Remote Resource Reading ---
async function readRemoteResource(url: string, uri: string): Promise<any> {
  await initRemoteServer(url);
  return jsonRpcCall(url, 2, "resources/read", { uri });
}

// --- Remote Prompt Getting ---
async function getRemotePrompt(
  url: string,
  promptName: string,
  promptArgs: Record<string, string> = {}
): Promise<any> {
  await initRemoteServer(url);
  return jsonRpcCall(url, 2, "prompts/get", { name: promptName, arguments: promptArgs });
}

// --- Response Formatting ---
function formatServerResult(serverData: any, url: string): { type: string; text: string }[] {
  const content: { type: string; text: string }[] = [];

  // Surface instructions as natural language guidance the model will follow
  if (serverData.instructions) {
    content.push({
      type: "text",
      text:
        `[Server Instructions from ${serverData.serverInfo?.name || url}]\n` +
        `${serverData.instructions}\n` +
        `Use call_remote_tool with url "${url}" to execute any of the tools listed below.`,
    });
  }

  // Add the structured data
  content.push({
    type: "text",
    text: JSON.stringify({ url, ...serverData }, null, 2),
  });

  return content;
}

// --- Server Setup ---
const server = new Server(
  {
    name: "mcp-browse",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "When a user mentions a domain name, company, or website — or when you need to find tools and services related to a domain — use mcp-browse first. " +
      "Start with browse_discover to look up the domain and inspect what MCP services it offers in a single step. " +
      "If you already have a server URL, use browse_server to see its tools, resources, and prompts. " +
      "Then use call_remote_tool to execute tools on discovered servers.",
  }
);

// --- Tool Definitions ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "browse_domain",
        description:
          "Lookup _mcp.{domain} DNS TXT records and return parsed MCP server metadata. Uses standard UDP DNS queries.",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "The domain to look up (e.g., 'example.com')",
            },
          },
          required: ["domain"],
        },
      },
      {
        name: "browse_server",
        description:
          "Connect to a discovered MCP server URL and retrieve its full manifest: tools, resources, and prompts. Lets you inspect what a server offers before deciding to use it.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The MCP server URL (e.g., 'https://mcp.example.com')",
            },
          },
          required: ["url"],
        },
      },
      {
        name: "browse_multi",
        description:
          "Batch lookup across multiple domains in a single call. Returns MCP server metadata for each domain that has _mcp TXT records.",
        inputSchema: {
          type: "object",
          properties: {
            domains: {
              type: "array",
              items: { type: "string" },
              description: "Array of domains to look up",
            },
          },
          required: ["domains"],
        },
      },
      {
        name: "browse_discover",
        description:
          "Start here when a user mentions any domain name or website. Looks up _mcp.{domain} DNS TXT records, then connects to the advertised server URL to retrieve its full manifest (tools, resources, and prompts) — all in one step.",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "The domain to discover (e.g., 'example.com')",
            },
          },
          required: ["domain"],
        },
      },
      {
        name: "call_remote_tool",
        description:
          "Call a tool on a remote MCP server. Use browse_server first to discover available tools, then use this to execute them.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The MCP server URL (e.g., 'https://mcp.example.com')",
            },
            tool: {
              type: "string",
              description: "The name of the tool to call on the remote server",
            },
            arguments: {
              type: "object",
              description: "Arguments to pass to the remote tool",
              additionalProperties: true,
            },
          },
          required: ["url", "tool"],
        },
      },
      {
        name: "read_remote_resource",
        description:
          "Read a resource from a remote MCP server. Use browse_server or browse_discover first to see available resources, then use this to read one by its URI.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The MCP server URL (e.g., 'https://mcp.example.com')",
            },
            uri: {
              type: "string",
              description: "The resource URI to read (e.g., 'file:///path/to/file')",
            },
          },
          required: ["url", "uri"],
        },
      },
      {
        name: "get_remote_prompt",
        description:
          "Get a prompt from a remote MCP server. Use browse_server or browse_discover first to see available prompts, then use this to retrieve one with optional arguments.",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The MCP server URL (e.g., 'https://mcp.example.com')",
            },
            prompt: {
              type: "string",
              description: "The name of the prompt to get",
            },
            arguments: {
              type: "object",
              description: "Arguments to pass to the prompt",
              additionalProperties: { type: "string" },
            },
          },
          required: ["url", "prompt"],
        },
      },
    ],
  };
});

// --- Tool Handlers ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "browse_domain": {
      const domain = (args as { domain: string }).domain;

      try {
        const result = await lookupMcpDomain(domain);

        if (result === null) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { domain, found: false, message: `No _mcp.${domain} TXT record found` },
                  null,
                  2
                ),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ domain, found: true, record: result }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ domain, error: err.message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }

    case "browse_server": {
      const url = (args as { url: string }).url;

      try {
        const result = await inspectMcpServer(url);
        return { content: formatServerResult(result, url) };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ url, error: err.message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }

    case "browse_multi": {
      const domains = (args as { domains: string[] }).domains;

      const results: Record<string, any> = {};

      await Promise.all(
        domains.map(async (domain) => {
          try {
            const record = await lookupMcpDomain(domain);
            results[domain] = record !== null ? { found: true, record } : { found: false };
          } catch (err: any) {
            results[domain] = { error: err.message };
          }
        })
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    }

    case "browse_discover": {
      const domain = (args as { domain: string }).domain;

      try {
        const result = await discoverMcpDomain(domain);
        // If we got server data with instructions, surface them prominently
        if (result.server && !result.server.error && result.server.instructions) {
          const content = formatServerResult(result.server, result.server.url);
          // Prepend the discovery context
          content.unshift({
            type: "text",
            text: `Discovered MCP server for ${domain} via DNS lookup of _mcp.${domain}`,
          });
          return { content };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ domain, error: err.message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }

    case "call_remote_tool": {
      const { url, tool, arguments: remoteArgs } = args as {
        url: string;
        tool: string;
        arguments?: Record<string, unknown>;
      };

      try {
        const result = await callRemoteTool(url, tool, remoteArgs || {});
        return {
          content: result?.content || [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ url, tool, error: err.message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }

    case "read_remote_resource": {
      const { url, uri } = args as { url: string; uri: string };

      try {
        const result = await readRemoteResource(url, uri);
        return {
          content: result?.contents?.map((c: any) => ({
            type: "text",
            text: typeof c.text === "string" ? c.text : JSON.stringify(c, null, 2),
          })) || [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ url, uri, error: err.message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }

    case "get_remote_prompt": {
      const { url, prompt, arguments: promptArgs } = args as {
        url: string;
        prompt: string;
        arguments?: Record<string, string>;
      };

      try {
        const result = await getRemotePrompt(url, prompt, promptArgs || {});
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ url, prompt, error: err.message }, null, 2),
            },
          ],
          isError: true,
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Start Server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-browse server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
