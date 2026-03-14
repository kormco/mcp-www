#!/usr/bin/env node
/**
 * mcp-www
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

// Allow overriding the DNS resolver via environment variable.
// Supports "host:port" format (e.g., "192.168.68.133:5335").
if (process.env.MCP_DNS_SERVER) {
  dns.setServers([process.env.MCP_DNS_SERVER]);
}

const resolveTxt = promisify(dns.resolveTxt);

// --- IDN Homograph Detection ---
function detectHomograph(domain: string): string | null {
  const labels = domain.split(".");

  // Check for punycode-encoded labels (ACE prefix)
  const punycodeLabels = labels.filter((l) => l.startsWith("xn--"));
  if (punycodeLabels.length > 0) {
    return `Domain contains punycode-encoded label(s): ${punycodeLabels.join(", ")}. This may be an IDN homograph attack — visually similar characters from different scripts (e.g., Cyrillic) can make a domain look identical to a legitimate one.`;
  }

  // Check for mixed Unicode scripts within a single label
  for (const label of labels) {
    let hasLatin = false;
    let hasNonLatin = false;
    let detectedScripts: string[] = [];

    for (const char of label) {
      const code = char.codePointAt(0)!;
      if (code >= 0x41 && code <= 0x7a) {
        hasLatin = true;
      } else if (code >= 0x0400 && code <= 0x04ff) {
        hasNonLatin = true;
        if (!detectedScripts.includes("Cyrillic")) detectedScripts.push("Cyrillic");
      } else if (code >= 0x0370 && code <= 0x03ff) {
        hasNonLatin = true;
        if (!detectedScripts.includes("Greek")) detectedScripts.push("Greek");
      }
    }

    if (hasLatin && hasNonLatin) {
      return `Domain label "${label}" mixes Latin with ${detectedScripts.join("/")} characters. This is a strong indicator of an IDN homograph attack.`;
    }

    if (hasNonLatin && !hasLatin && detectedScripts.length > 0) {
      return `Domain label "${label}" uses ${detectedScripts.join("/")} script characters that may visually mimic Latin characters. Verify this is the intended domain.`;
    }
  }

  return null;
}

function formatHomographWarning(warning: string): { type: string; text: string } {
  return {
    type: "text",
    text: [
      "////// SECURITY WARNING //////",
      "IDN HOMOGRAPH ATTACK DETECTED",
      warning,
      "DO NOT proceed without verifying this is the intended domain. Ask the user to confirm.",
      "//////////////////////////////",
    ].join("\n"),
  };
}

// --- TXT Record Parser ---
function parseSingleTxtRecord(chunks: string[]): Record<string, string> {
  const fullRecord = chunks.join("");
  const result: Record<string, string> = {};
  const pairs = fullRecord.split(";").map((s) => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      result[pair.slice(0, eqIndex).trim()] = pair.slice(eqIndex + 1).trim();
    }
  }
  return result;
}

// --- DNS Lookup (returns ALL TXT records) ---
async function lookupMcpDomain(domain: string): Promise<{ records: Record<string, string>[]; homograph_warning?: string }> {
  const normalized = domain.normalize("NFC");
  const warning = detectHomograph(normalized);

  const mcpDomain = `_mcp.${normalized}`;

  try {
    const rawRecords = await resolveTxt(mcpDomain);
    if (rawRecords.length === 0) {
      return { records: [], ...(warning && { homograph_warning: warning }) };
    }
    const parsed = rawRecords.map((chunks) => parseSingleTxtRecord(chunks));
    return { records: parsed, ...(warning && { homograph_warning: warning }) };
  } catch (err: any) {
    if (err.code === "ENODATA" || err.code === "ENOTFOUND") {
      return { records: [], ...(warning && { homograph_warning: warning }) };
    }
    throw err;
  }
}

// --- MCP Server Inspection (initialize + list tools/resources/prompts) ---
async function inspectMcpServer(url: string): Promise<any> {
  const initResponse = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mcp-www", version: "0.2.0" },
      },
    }),
  });

  if (!initResponse.ok) {
    throw new Error(`Server returned ${initResponse.status}`);
  }

  const initResult = await initResponse.json();
  const sessionId = initResponse.headers.get("mcp-session-id");

  const sessionHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) {
    sessionHeaders["mcp-session-id"] = sessionId;
  }

  const jsonRpcPost = (id: number, method: string) =>
    fetch(url, {
      method: "POST",
      headers: sessionHeaders,
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

// --- Server Card (.well-known/mcp.json) ---
async function fetchServerCard(domain: string): Promise<any | null> {
  try {
    const response = await fetch(`https://${domain}/.well-known/mcp.json`, {
      signal: AbortSignal.timeout(10000),
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// --- Browse: parallel server card + MCP initialize ---
async function browseDomain(domain: string): Promise<any> {
  const normalized = domain.normalize("NFC");
  const warning = detectHomograph(normalized);

  // First, DNS lookup to find server URLs
  const { records } = await lookupMcpDomain(normalized);

  // Extract all server URLs from DNS records
  const serverUrls = records
    .map((r) => r.src || r.endpoint)
    .filter(Boolean) as string[];

  // Parallel: server card + inspect all DNS-advertised servers
  const [serverCard, ...serverResults] = await Promise.all([
    fetchServerCard(normalized),
    ...serverUrls.map(async (url) => {
      try {
        const info = await inspectMcpServer(url);
        return { url, ...info };
      } catch (err: any) {
        return { url, error: err.message };
      }
    }),
  ]);

  return {
    domain: normalized,
    ...(warning && { homograph_warning: warning }),
    dns_records: records,
    server_card: serverCard,
    servers: serverResults,
  };
}

// --- Browse by URL ---
async function browseUrl(url: string): Promise<any> {
  const info = await inspectMcpServer(url);
  return { url, ...info };
}

// --- Remote Server Helpers ---
async function initRemoteServer(url: string): Promise<string | null> {
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
        clientInfo: { name: "mcp-www", version: "0.2.0" },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status} during initialization`);
  }

  return response.headers.get("mcp-session-id");
}

async function jsonRpcCall(url: string, id: number, method: string, params: Record<string, unknown>, sessionId?: string | null): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
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

async function callRemoteTool(
  url: string,
  toolName: string,
  toolArgs: Record<string, unknown> = {}
): Promise<any> {
  const sessionId = await initRemoteServer(url);
  return jsonRpcCall(url, 2, "tools/call", { name: toolName, arguments: toolArgs }, sessionId);
}

async function readRemoteResource(url: string, uri: string): Promise<any> {
  const sessionId = await initRemoteServer(url);
  return jsonRpcCall(url, 2, "resources/read", { uri }, sessionId);
}

async function getRemotePrompt(
  url: string,
  promptName: string,
  promptArgs: Record<string, string> = {}
): Promise<any> {
  const sessionId = await initRemoteServer(url);
  return jsonRpcCall(url, 2, "prompts/get", { name: promptName, arguments: promptArgs }, sessionId);
}

// --- Discover + Browse (lightweight: DNS + server card, init as fallback) ---
async function discoverBrowse(domain: string): Promise<any> {
  const normalized = domain.normalize("NFC");
  const warning = detectHomograph(normalized);

  const { records } = await lookupMcpDomain(normalized);

  const base: any = {
    domain: normalized,
    ...(warning && { homograph_warning: warning }),
    dns_records: records,
  };

  if (records.length === 0) {
    return { ...base, found: false, message: `No _mcp.${normalized} TXT record found` };
  }

  // Take the first server URL
  const serverUrl = records.map((r) => r.src || r.endpoint).find(Boolean);
  if (!serverUrl) {
    return { ...base, found: true, server: null, message: "No server URL (src/endpoint) in TXT records" };
  }

  // Try server card first (cheap HTTP GET)
  const serverCard = await fetchServerCard(normalized);
  if (serverCard) {
    return { ...base, found: true, server_url: serverUrl, server_card: serverCard };
  }

  // Fallback: MCP initialize handshake
  try {
    const serverInfo = await inspectMcpServer(serverUrl);
    return { ...base, found: true, server_url: serverUrl, server: serverInfo };
  } catch (err: any) {
    return { ...base, found: true, server_url: serverUrl, server: { error: err.message } };
  }
}

// --- Server Registration ---
function generateRegistrationConfig(url: string, serverName: string): any {
  const platform = process.platform;
  const homeDir = process.env.HOME || process.env.USERPROFILE || "~";
  const appData = process.env.APPDATA || "";

  const configs: Record<string, any> = {
    claude_desktop: {
      config_path:
        platform === "win32"
          ? `${appData}\\Claude\\claude_desktop_config.json`
          : platform === "darwin"
            ? `${homeDir}/Library/Application Support/Claude/claude_desktop_config.json`
            : `${homeDir}/.config/Claude/claude_desktop_config.json`,
      entry: { [serverName]: { url } },
      merge_at: "mcpServers",
    },
    vscode: {
      config_path: ".vscode/mcp.json",
      entry: { [serverName]: { url } },
      merge_at: "servers",
    },
    cursor: {
      config_path: `${homeDir}/.cursor/mcp.json`,
      entry: { [serverName]: { url } },
      merge_at: "mcpServers",
    },
    windsurf: {
      config_path: `${homeDir}/.windsurf/mcp.json`,
      entry: { [serverName]: { url } },
      merge_at: "mcpServers",
    },
  };

  return {
    server_name: serverName,
    server_url: url,
    platform,
    configs,
    instructions:
      "To register this server: read the config file for the target client, " +
      "parse as JSON, add the entry object under the merge_at key, and write it back. " +
      "If the file doesn't exist, create it with { [merge_at]: entry }. " +
      "Do not overwrite existing server entries unless the user confirms.",
  };
}

function deriveServerName(domain: string): string {
  return domain
    .replace(/^mcp\./, "")
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]/gi, "")
    .toLowerCase();
}

// --- Server Setup ---
const server = new Server(
  {
    name: "mcp-www",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "When a user mentions a domain name, company, or website — or when you need to find tools and services related to a domain — use mcp-www. " +
      "Start with discover_browse for a quick one-step DNS + server card lookup. " +
      "Use browse for full MCP handshake and complete server manifest. " +
      "Use call_remote_tool to execute tools on discovered servers. " +
      "Use install to permanently add a discovered server to the user's MCP client.",
  }
);

// --- Tool Definitions ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "discover",
        description:
          "DNS-only lookup. Returns all _mcp.{domain} TXT records — there can be multiple, each advertising a different MCP server. Fast, cheap, no HTTP calls. Supports single domain or batch lookup across multiple domains.",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "A single domain to look up (e.g., 'example.com')",
            },
            domains: {
              type: "array",
              items: { type: "string" },
              description: "Multiple domains to look up in parallel",
            },
          },
        },
      },
      {
        name: "discover_browse",
        description:
          "DNS lookup + server card in one call. Looks up all _mcp.{domain} TXT records, then fetches .well-known/mcp.json for server metadata. Only falls back to MCP initialize if no server card is found. Lighter than browse — no MCP session unless needed.",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "The domain to discover and browse (e.g., 'example.com')",
            },
          },
          required: ["domain"],
        },
      },
      {
        name: "browse",
        description:
          "Connect and inspect. Takes a domain or server URL. For domains: parallel fetch of .well-known/mcp.json (server card) and MCP initialize handshake on all DNS-advertised servers. For URLs: direct MCP handshake. Returns full server manifest (tools, resources, prompts).",
        inputSchema: {
          type: "object",
          properties: {
            domain: {
              type: "string",
              description: "Domain to browse (e.g., 'example.com') — runs parallel server card + MCP handshake",
            },
            url: {
              type: "string",
              description: "Direct MCP server URL to inspect (e.g., 'https://mcp.example.com')",
            },
          },
        },
      },
      {
        name: "call_remote_tool",
        description:
          "Call a tool on a remote MCP server. Use browse first to discover available tools, then use this to execute them.",
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
          "Read a resource from a remote MCP server. Use browse first to see available resources, then use this to read one by its URI.",
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
          "Get a prompt from a remote MCP server. Use browse first to see available prompts, then use this to retrieve one with optional arguments.",
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
      {
        name: "install",
        description:
          "Generate client configuration to permanently register a discovered MCP server. Returns config file paths and JSON entries for Claude Desktop, VS Code, Cursor, and Windsurf. The agent should then read the target config file, merge the entry, and write it back. Accepts a server URL directly or a domain (runs discovery first).",
        inputSchema: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "The MCP server URL to register (e.g., 'https://mcp.example.com')",
            },
            domain: {
              type: "string",
              description: "Domain to discover first, then register the found server URL",
            },
            name: {
              type: "string",
              description: "Friendly name for the server entry (auto-derived from domain/URL if omitted)",
            },
          },
        },
      },
    ],
  };
});

// --- Tool Handlers ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "discover": {
      const { domain, domains } = args as { domain?: string; domains?: string[] };
      const domainList = domains || (domain ? [domain] : []);

      if (domainList.length === 0) {
        return {
          content: [{ type: "text", text: "Provide either 'domain' (string) or 'domains' (array)." }],
          isError: true,
        };
      }

      const results: Record<string, any> = {};
      const warnings: { type: string; text: string }[] = [];

      await Promise.all(
        domainList.map(async (d) => {
          try {
            const { records, homograph_warning } = await lookupMcpDomain(d);
            results[d] = records.length > 0
              ? { found: true, records }
              : { found: false, message: `No _mcp.${d} TXT record found` };
            if (homograph_warning) warnings.push(formatHomographWarning(`[${d}] ${homograph_warning}`));
          } catch (err: any) {
            results[d] = { error: err.message };
          }
        })
      );

      const content: { type: string; text: string }[] = [
        ...warnings,
        { type: "text", text: JSON.stringify(domainList.length === 1 ? results[domainList[0]] : results, null, 2) },
      ];

      // Suggest browse for domains that have records
      const domainsWithRecords = domainList.filter((d) => results[d]?.found);
      if (domainsWithRecords.length > 0) {
        content.push({
          type: "text",
          text: `Use browse to connect and inspect ${domainsWithRecords.length === 1 ? `${domainsWithRecords[0]}` : "these domains"}.`,
        });
      }

      return { content };
    }

    case "discover_browse": {
      const domain = (args as { domain: string }).domain;

      try {
        const result = await discoverBrowse(domain);
        const content: { type: string; text: string }[] = [];

        if (result.homograph_warning) {
          content.push(formatHomographWarning(result.homograph_warning));
        }

        content.push({
          type: "text",
          text: JSON.stringify(result, null, 2),
        });

        if (result.server_url) {
          content.push({
            type: "text",
            text: `Use browse to get the full server manifest, or install to add this server to your MCP client.`,
          });
        }

        return { content };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ domain, error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }

    case "browse": {
      const { domain, url } = args as { domain?: string; url?: string };

      if (!domain && !url) {
        return {
          content: [{ type: "text", text: "Provide either 'domain' or 'url'." }],
          isError: true,
        };
      }

      try {
        let result: any;
        if (url) {
          result = await browseUrl(url);
        } else {
          result = await browseDomain(domain!);
        }

        const content: { type: string; text: string }[] = [];
        const warningText = result.homograph_warning;
        if (warningText) {
          content.push(formatHomographWarning(warningText));
        }

        // Surface instructions from any successfully connected server
        const servers = result.servers || (result.url ? [result] : []);
        for (const srv of servers) {
          if (srv.instructions) {
            content.push({
              type: "text",
              text:
                `[Server Instructions from ${srv.serverInfo?.name || srv.url}]\n` +
                `${srv.instructions}\n` +
                `Use call_remote_tool with url "${srv.url}" to execute any of the tools listed below.`,
            });
          }
        }

        content.push({
          type: "text",
          text: JSON.stringify(result, null, 2),
        });

        // Suggest register for servers that connected successfully
        const connectedUrls = servers.filter((s: any) => !s.error && s.serverInfo).map((s: any) => s.url);
        if (connectedUrls.length > 0) {
          content.push({
            type: "text",
            text: `To permanently add ${connectedUrls.length === 1 ? "this server" : "these servers"} to the user's MCP client, use install.`,
          });
        }

        return { content };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ domain, url, error: err.message }, null, 2) }],
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
          content: [{ type: "text", text: JSON.stringify({ url, tool, error: err.message }, null, 2) }],
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
          content: [{ type: "text", text: JSON.stringify({ url, uri, error: err.message }, null, 2) }],
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
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: JSON.stringify({ url, prompt, error: err.message }, null, 2) }],
          isError: true,
        };
      }
    }

    case "install": {
      const { url, domain, name: serverName } = args as {
        url?: string;
        domain?: string;
        name?: string;
      };

      if (!url && !domain) {
        return {
          content: [{ type: "text", text: "Provide either 'url' (server URL) or 'domain' (to discover first)." }],
          isError: true,
        };
      }

      let serverUrl = url;
      let discoveredDomain = domain;

      // If domain provided, discover the server URL first
      if (!serverUrl && domain) {
        try {
          const { records } = await lookupMcpDomain(domain);
          const firstUrl = records.map((r) => r.src || r.endpoint).find(Boolean);
          if (firstUrl) {
            serverUrl = firstUrl;
          }
        } catch (err: any) {
          return {
            content: [{ type: "text", text: JSON.stringify({ domain, error: `Discovery failed: ${err.message}` }, null, 2) }],
            isError: true,
          };
        }

        if (!serverUrl) {
          return {
            content: [{ type: "text", text: JSON.stringify({ domain, error: "No MCP server URL found for this domain. Cannot register." }, null, 2) }],
            isError: true,
          };
        }
      }

      const derivedName = serverName || deriveServerName(
        discoveredDomain || new URL(serverUrl!).hostname
      );

      const config = generateRegistrationConfig(serverUrl!, derivedName);

      const content: { type: string; text: string }[] = [];

      if (discoveredDomain) {
        content.push({
          type: "text",
          text: `Discovered server at ${serverUrl} via DNS lookup of _mcp.${discoveredDomain}`,
        });
      }

      content.push({
        type: "text",
        text: JSON.stringify(config, null, 2),
      });

      content.push({
        type: "text",
        text:
          `To complete registration, read the config file for the target client, ` +
          `merge the entry under the "${config.configs.claude_desktop.merge_at}" key, and write it back. ` +
          `If the file doesn't exist, create it.`,
      });

      return { content };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Start Server ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("mcp-www server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
