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
  // Common confusable scripts: Cyrillic, Greek, Latin
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
      } else if (code >= 0x0100 && code <= 0x024f) {
        // Latin Extended — not suspicious on its own but flag with others
      }
    }

    if (hasLatin && hasNonLatin) {
      return `Domain label "${label}" mixes Latin with ${detectedScripts.join("/")} characters. This is a strong indicator of an IDN homograph attack.`;
    }

    // Fully non-Latin label (e.g., all Cyrillic) pretending to be a common domain
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
async function lookupMcpDomain(domain: string): Promise<{ record: Record<string, string> | null; homograph_warning?: string }> {
  // Normalize Unicode and detect homograph attacks
  const normalized = domain.normalize("NFC");
  const warning = detectHomograph(normalized);

  const mcpDomain = `_mcp.${normalized}`;

  try {
    const records = await resolveTxt(mcpDomain);
    if (records.length === 0) {
      return { record: null, ...(warning && { homograph_warning: warning }) };
    }
    return { record: parseMcpTxtRecord(records), ...(warning && { homograph_warning: warning }) };
  } catch (err: any) {
    if (err.code === "ENODATA" || err.code === "ENOTFOUND") {
      return { record: null, ...(warning && { homograph_warning: warning }) };
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
        clientInfo: { name: "mcp-www", version: "0.1.0" },
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

// --- Combined Discovery + Inspection ---
async function discoverMcpDomain(domain: string): Promise<any> {
  const { record, homograph_warning } = await lookupMcpDomain(domain);
  const base: any = { domain, ...(homograph_warning && { homograph_warning }) };

  if (record === null) {
    return { ...base, found: false, message: `No _mcp.${domain} TXT record found` };
  }

  const serverUrl = record.src || record.endpoint;
  if (!serverUrl) {
    return { ...base, found: true, record, server: null, message: "No server URL (src/endpoint) in TXT record" };
  }

  try {
    const serverInfo = await inspectMcpServer(serverUrl);
    return { ...base, found: true, record, server: { url: serverUrl, ...serverInfo } };
  } catch (err: any) {
    return { ...base, found: true, record, server: { url: serverUrl, error: err.message } };
  }
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
        clientInfo: { name: "mcp-www", version: "0.1.0" },
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

// --- Remote Tool Calling ---
async function callRemoteTool(
  url: string,
  toolName: string,
  toolArgs: Record<string, unknown> = {}
): Promise<any> {
  const sessionId = await initRemoteServer(url);
  return jsonRpcCall(url, 2, "tools/call", { name: toolName, arguments: toolArgs }, sessionId);
}

// --- Remote Resource Reading ---
async function readRemoteResource(url: string, uri: string): Promise<any> {
  const sessionId = await initRemoteServer(url);
  return jsonRpcCall(url, 2, "resources/read", { uri }, sessionId);
}

// --- Remote Prompt Getting ---
async function getRemotePrompt(
  url: string,
  promptName: string,
  promptArgs: Record<string, string> = {}
): Promise<any> {
  const sessionId = await initRemoteServer(url);
  return jsonRpcCall(url, 2, "prompts/get", { name: promptName, arguments: promptArgs }, sessionId);
}

// --- Broad Discovery (browse_all) ---
async function fetchLlmsTxt(domain: string): Promise<string | null> {
  try {
    const response = await fetch(`https://${domain}/llms.txt`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim() || null;
  } catch {
    return null;
  }
}

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

async function probeDirectMcp(domain: string): Promise<any | null> {
  // Try common MCP endpoint patterns
  const candidates = [`https://mcp.${domain}`, `https://${domain}`];

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "mcp-www", version: "0.1.0" },
          },
        }),
      });

      if (!response.ok) continue;
      const result = await response.json();
      if (result?.result?.protocolVersion) {
        return { url, serverInfo: result.result.serverInfo || null, protocolVersion: result.result.protocolVersion };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function browseAll(domain: string): Promise<any> {
  const normalized = domain.normalize("NFC");
  const warning = detectHomograph(normalized);

  const [dnsResult, llmsTxt, serverCard, directProbe] = await Promise.all([
    lookupMcpDomain(normalized),
    fetchLlmsTxt(normalized),
    fetchServerCard(normalized),
    probeDirectMcp(normalized),
  ]);

  // If DNS found a server URL, inspect it too
  let dnsServer = null;
  if (dnsResult.record) {
    const serverUrl = dnsResult.record.src || dnsResult.record.endpoint;
    if (serverUrl) {
      try {
        dnsServer = await inspectMcpServer(serverUrl);
        dnsServer = { url: serverUrl, ...dnsServer };
      } catch (err: any) {
        dnsServer = { url: serverUrl, error: err.message };
      }
    }
  }

  return {
    domain: normalized,
    ...(warning && { homograph_warning: warning }),
    dns: dnsResult.record
      ? { found: true, record: dnsResult.record, server: dnsServer }
      : { found: false },
    llms_txt: llmsTxt,
    server_card: serverCard,
    direct: directProbe,
  };
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
    name: "mcp-www",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
    instructions:
      "When a user mentions a domain name, company, or website — or when you need to find tools and services related to a domain — use mcp-www first. " +
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
        name: "browse_all",
        description:
          "Comprehensive discovery across all known mechanisms for a single domain. Concurrently checks DNS TXT records (_mcp.{domain}), llms.txt, .well-known/mcp.json (server card), and direct MCP endpoint probing. Returns a unified response with results from each method.",
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
        const { record, homograph_warning } = await lookupMcpDomain(domain);
        const warningBlock = homograph_warning ? [formatHomographWarning(homograph_warning)] : [];

        if (record === null) {
          return {
            content: [
              ...warningBlock,
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
            ...warningBlock,
            {
              type: "text",
              text: JSON.stringify({ domain, found: true, record }, null, 2),
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
      const warnings: { domain: string; warning: string }[] = [];

      await Promise.all(
        domains.map(async (domain) => {
          try {
            const { record, homograph_warning } = await lookupMcpDomain(domain);
            results[domain] = record !== null
              ? { found: true, record }
              : { found: false };
            if (homograph_warning) warnings.push({ domain, warning: homograph_warning });
          } catch (err: any) {
            results[domain] = { error: err.message };
          }
        })
      );

      const warningBlocks = warnings.map((w) =>
        formatHomographWarning(`[${w.domain}] ${w.warning}`)
      );

      return {
        content: [
          ...warningBlocks,
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
        const warningBlock = result.homograph_warning ? [formatHomographWarning(result.homograph_warning)] : [];

        // If we got server data with instructions, surface them prominently
        if (result.server && !result.server.error && result.server.instructions) {
          const content = formatServerResult(result.server, result.server.url);
          // Prepend warning + discovery context
          content.unshift({
            type: "text",
            text: `Discovered MCP server for ${domain} via DNS lookup of _mcp.${domain}`,
          });
          content.unshift(...warningBlock);
          return { content };
        }
        return {
          content: [
            ...warningBlock,
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

    case "browse_all": {
      const domain = (args as { domain: string }).domain;

      try {
        const result = await browseAll(domain);
        const warningBlock = result.homograph_warning ? [formatHomographWarning(result.homograph_warning)] : [];
        const content: { type: string; text: string }[] = [...warningBlock];

        // Surface llms.txt as raw context
        if (result.llms_txt) {
          content.push({
            type: "text",
            text: `[llms.txt for ${domain}]\n${result.llms_txt}`,
          });
        }

        // Surface server instructions if found via DNS
        if (result.dns?.server && !result.dns.server.error && result.dns.server.instructions) {
          content.push({
            type: "text",
            text:
              `[Server Instructions from ${result.dns.server.serverInfo?.name || result.dns.server.url}]\n` +
              `${result.dns.server.instructions}\n` +
              `Use call_remote_tool with url "${result.dns.server.url}" to execute any of the tools listed below.`,
          });
        }

        // Unified structured response
        content.push({
          type: "text",
          text: JSON.stringify(result, null, 2),
        });

        return { content };
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
  console.error("mcp-www server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
