#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import fs from "fs";

dotenv.config();

const logFilePath = "E:/dev/shodan-mcp/server.log";
const SHODAN_API_KEY = process.env.SHODAN_API_KEY;
if (!SHODAN_API_KEY) {
  throw new Error("SHODAN_API_KEY environment variable is required.");
}

const API_BASE_URL = "https://api.shodan.io";

// Logging Helper Function
function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logFilePath, formattedMessage, "utf8");
  console.error(formattedMessage.trim()); // Use stderr for logging to avoid interfering with stdout
}

// Tool Schemas
const IpLookupArgsSchema = z.object({
  ip: z.string().describe("The IP address to query."),
});

const SearchArgsSchema = z.object({
  query: z.string().describe("Search query for Shodan."),
  max_results: z
    .number()
    .optional()
    .default(10)
    .describe("Maximum results to return."),
});

const VulnerabilitiesArgsSchema = z.object({
  cve: z.string().describe("The CVE identifier to query."),
});

const DnsLookupArgsSchema = z.object({
  hostnames: z.array(z.string()).describe("List of hostnames to resolve."),
});

// Helper Function to Query Shodan API
async function queryShodan(endpoint: string, params: Record<string, any>) {
  try {
    const response = await axios.get(`${API_BASE_URL}${endpoint}`, {
      params: { ...params, key: SHODAN_API_KEY },
      timeout: 10000,
    });
    return response.data;
  } catch (error: any) {
    const errorMessage = error.response?.data?.error || error.message;
    logToFile(`Shodan API error: ${errorMessage}`);
    throw new Error(`Shodan API error: ${errorMessage}`);
  }
}

// Server Setup
const server = new Server(
  {
    name: "shodan-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: true,
      },
    },
  }
);

// Handle Initialization
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  logToFile("Received initialize request.");
  return {
    protocolVersion: "2024-11-05",
    capabilities: {
      tools: {
        listChanged: true,
      },
    },
    serverInfo: {
      name: "shodan-mcp",
      version: "1.0.0",
    },
    instructions:
      "This server provides tools for querying Shodan, including IP lookups, searches, and vulnerabilities.",
  };
});

// Register Tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "ip_lookup",
      description: "Retrieve information about an IP address.",
      inputSchema: zodToJsonSchema(IpLookupArgsSchema),
    },
    {
      name: "search",
      description: "Search for devices on Shodan.",
      inputSchema: zodToJsonSchema(SearchArgsSchema),
    },
    {
      name: "vulnerabilities",
      description: "Retrieve vulnerability information for a CVE.",
      inputSchema: zodToJsonSchema(VulnerabilitiesArgsSchema),
    },
    {
      name: "dns_lookup",
      description: "Perform DNS lookups using Shodan.",
      inputSchema: zodToJsonSchema(DnsLookupArgsSchema),
    },
  ];

  logToFile("Registered tools.");
  return { tools };
});

// Handle Tool Calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  logToFile(`Tool called: ${request.params.name}`);

  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "ip_lookup": {
        const parsedIpArgs = IpLookupArgsSchema.safeParse(args);
        if (!parsedIpArgs.success) {
          throw new Error("Invalid ip_lookup arguments");
        }
        const result = await queryShodan(`/shodan/host/${parsedIpArgs.data.ip}`, {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "search": {
        const parsedSearchArgs = SearchArgsSchema.safeParse(args);
        if (!parsedSearchArgs.success) {
          throw new Error("Invalid search arguments");
        }
        const result = await queryShodan("/shodan/host/search", {
          query: parsedSearchArgs.data.query,
          limit: parsedSearchArgs.data.max_results,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "vulnerabilities": {
        const parsedVulnArgs = VulnerabilitiesArgsSchema.safeParse(args);
        if (!parsedVulnArgs.success) {
          throw new Error("Invalid vulnerabilities arguments");
        }
        const result = await queryShodan(`/shodan/cve/${parsedVulnArgs.data.cve}`, {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "dns_lookup": {
        const parsedDnsArgs = DnsLookupArgsSchema.safeParse(args);
        if (!parsedDnsArgs.success) {
          throw new Error("Invalid dns_lookup arguments");
        }
        
        // Ensure proper formatting of hostnames for the API request
        const hostnamesString = parsedDnsArgs.data.hostnames.join(",");
        
        // Log the request parameters for debugging
        logToFile(`DNS lookup request parameters: ${JSON.stringify({ hostnames: hostnamesString })}`);
        
        const result = await queryShodan("/dns/resolve", {
          hostnames: hostnamesString
        });
        
        // Log the raw response for debugging
        logToFile(`DNS lookup raw response: ${JSON.stringify(result)}`);
        
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logToFile(`Error handling tool call: ${errorMessage}`);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Start the Server
async function runServer() {
  logToFile("Starting Shodan MCP Server...");

  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logToFile("Shodan MCP Server is running.");
  } catch (error: any) {
    logToFile(`Error connecting server: ${error.message}`);
    process.exit(1);
  }
}

// Handle process events
process.on('uncaughtException', (error) => {
  logToFile(`Uncaught exception: ${error.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logToFile(`Unhandled rejection: ${reason}`);
  process.exit(1);
});

runServer().catch((error: any) => {
  logToFile(`Fatal error: ${error.message}`);
  process.exit(1);
});