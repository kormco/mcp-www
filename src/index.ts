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

  // Get tools list
  const toolsResponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });

  if (!toolsResponse.ok) {
    throw new Error(`Server returned ${toolsResponse.status}`);
  }

  const toolsResult = await toolsResponse.json();

  return {
    serverInfo: initResult.result?.serverInfo || null,
    protocolVersion: initResult.result?.protocolVersion || null,
    instructions: initResult.result?.instructions || null,
    tools: toolsResult.result?.tools || [],
  };
}

// --- Remote Tool Calling ---
async function callRemoteTool(
  url: string,
  toolName: string,
  toolArgs: Record<string, unknown> = {}
): Promise<any> {
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
    throw new Error(`Server returned ${initResponse.status} during initialization`);
  }

  // Call the tool
  const callResponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: toolArgs,
      },
    }),
  });

  if (!callResponse.ok) {
    throw new Error(`Server returned ${callResponse.status} during tool call`);
  }

  const callResult = await callResponse.json();

  if (callResult.error) {
    throw new Error(callResult.error.message || JSON.stringify(callResult.error));
  }

  return callResult.result;
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
          "Connect to a discovered MCP server URL and retrieve its tools/list manifest. Lets you inspect what a server offers before deciding to use it.",
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
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ url, ...result }, null, 2),
            },
          ],
        };
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
