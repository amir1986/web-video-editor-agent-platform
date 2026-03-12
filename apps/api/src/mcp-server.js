/**
 * MCP (Model Context Protocol) Server for Video Editing Tools
 *
 * Exposes video editing tools via the Model Context Protocol so that
 * any MCP-compatible AI client can use them directly.
 *
 * Protocol: JSON-RPC 2.0 over stdio
 *
 * Usage:
 *   node apps/api/src/mcp-server.js
 *
 * Or in an MCP client config:
 *   {
 *     "mcpServers": {
 *       "video-editor": {
 *         "command": "node",
 *         "args": ["apps/api/src/mcp-server.js"]
 *       }
 *     }
 *   }
 */

const readline = require("readline");
const { TOOL_DEFINITIONS, TOOL_HANDLERS, setToolContext } = require("./ai/tools");
const { searchKnowledge, KNOWLEDGE_BASE } = require("./ai/knowledge-base");

const SERVER_INFO = {
  name: "video-editor-mcp",
  version: "1.0.0",
  description: "Video editing tools — probe, analyze, extract frames, search knowledge base",
};

// ---------------------------------------------------------------------------
// MCP Protocol handler
// ---------------------------------------------------------------------------

class MCPServer {
  constructor() {
    this.initialized = false;
  }

  async handleRequest(request) {
    const { method, params, id } = request;

    switch (method) {
      case "initialize":
        return this.handleInitialize(params, id);
      case "initialized":
        this.initialized = true;
        return null; // Notification, no response
      case "tools/list":
        return this.handleToolsList(id);
      case "tools/call":
        return this.handleToolsCall(params, id);
      case "resources/list":
        return this.handleResourcesList(id);
      case "resources/read":
        return this.handleResourcesRead(params, id);
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
    }
  }

  handleInitialize(params, id) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: SERVER_INFO,
      },
    };
  }

  handleToolsList(id) {
    // Convert tool definitions to MCP format (inputSchema instead of input_schema)
    const tools = TOOL_DEFINITIONS.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
    }));

    return {
      jsonrpc: "2.0",
      id,
      result: { tools },
    };
  }

  async handleToolsCall(params, id) {
    const { name, arguments: args } = params;
    const handler = TOOL_HANDLERS[name];

    if (!handler) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` },
      };
    }

    try {
      const result = await handler(args || {});
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        },
      };
    }
  }

  handleResourcesList(id) {
    // Expose the knowledge base as a resource
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resources: [
          {
            uri: "knowledge://video-editing/all",
            name: "Video Editing Knowledge Base",
            description: "Professional video editing best practices, techniques, and guidelines",
            mimeType: "text/plain",
          },
          ...["cuts", "transitions", "pacing", "narrative", "technical"].map(cat => ({
            uri: `knowledge://video-editing/${cat}`,
            name: `Video Editing: ${cat.charAt(0).toUpperCase() + cat.slice(1)}`,
            description: `Knowledge base entries for ${cat}`,
            mimeType: "text/plain",
          })),
        ],
      },
    };
  }

  handleResourcesRead(params, id) {
    const { uri } = params;
    const match = uri.match(/^knowledge:\/\/video-editing\/(.+)$/);
    if (!match) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown resource: ${uri}` } };
    }

    const category = match[1];
    const entries = category === "all"
      ? KNOWLEDGE_BASE
      : KNOWLEDGE_BASE.filter(e => e.category === category);

    const text = entries
      .map(e => `## ${e.title}\n\n${e.content}`)
      .join("\n\n---\n\n");

    return {
      jsonrpc: "2.0",
      id,
      result: {
        contents: [{ uri, mimeType: "text/plain", text }],
      },
    };
  }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

function startServer() {
  const server = new MCPServer();
  const rl = readline.createInterface({ input: process.stdin });
  let buffer = "";

  rl.on("line", async (line) => {
    try {
      const request = JSON.parse(line);
      const response = await server.handleRequest(request);
      if (response) {
        process.stdout.write(JSON.stringify(response) + "\n");
      }
    } catch (err) {
      const errorResponse = {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: `Parse error: ${err.message}` },
      };
      process.stdout.write(JSON.stringify(errorResponse) + "\n");
    }
  });

  rl.on("close", () => process.exit(0));

  // Log to stderr so it doesn't interfere with JSON-RPC on stdout
  process.stderr.write(`[MCP] ${SERVER_INFO.name} v${SERVER_INFO.version} started\n`);
  process.stderr.write(`[MCP] Tools: ${TOOL_DEFINITIONS.map(t => t.name).join(", ")}\n`);
  process.stderr.write(`[MCP] Knowledge base: ${KNOWLEDGE_BASE.length} entries\n`);
}

if (require.main === module) {
  startServer();
}

module.exports = { MCPServer, SERVER_INFO };
