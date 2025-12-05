/**
 * Custom Atlassian MCP Server
 *
 * This Model Context Protocol (MCP) server provides tools for interacting with
 * Atlassian Jira Cloud APIs. It enables fetching issue attachments and retrieving
 * attachment image content through a standardized MCP interface.
 *
 * @module custom-atlassian-mcp
 * @version 1.0.0
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { config } from "dotenv";
import z from "zod";

// Load environment variables from .env file
config();

/**
 * ============================================================================
 * Configuration & Environment Variables
 * ============================================================================
 */

/**
 * Validates that all required environment variables are present.
 * Exits the process with an error message if any required variable is missing.
 *
 * @throws {Error} Exits process with code 1 if validation fails
 */
function validateEnvironment(): void {
  const required = {
    JIRA_DOMAIN: process.env.JIRA_DOMAIN,
    JIRA_EMAIL: process.env.JIRA_EMAIL,
    JIRA_API_TOKEN: process.env.JIRA_API_TOKEN,
  };

  const missing = Object.entries(required)
    .filter(([_, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    console.error(
      `[FATAL] Missing required environment variables: ${missing.join(", ")}`
    );
    console.error(
      "Please ensure these variables are set in your .env file or environment."
    );
    process.exit(1);
  }
}

// Validate environment before proceeding
validateEnvironment();

/**
 * Jira Cloud domain (e.g., "your-organization.atlassian.net")
 * Required for all Jira API requests.
 * @constant {string | undefined}
 */
const JIRA_DOMAIN = process.env.JIRA_DOMAIN;

/**
 * Jira user email address for Basic Authentication
 * Used in combination with JIRA_API_TOKEN for authentication.
 * @constant {string | undefined}
 */
const JIRA_EMAIL = process.env.JIRA_EMAIL;

/**
 * Jira API token for Basic Authentication
 * Generate from: https://id.atlassian.com/manage-profile/security/api-tokens
 * @constant {string | undefined}
 */
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

/**
 * ============================================================================
 * Authentication Helpers
 * ============================================================================
 */

/**
 * Generates a Basic Authentication header for Jira Cloud API requests.
 *
 * Jira Cloud uses Basic Auth with email:api_token as credentials.
 * The credentials are base64-encoded per HTTP Basic Auth specification (RFC 7617).
 *
 * @returns {string | null} Base64-encoded Basic Auth header value, or null if credentials are missing
 *
 * @example
 * // Returns: "Basic YWRtaW5AZXhhbXBsZS5jb206dG9rZW4xMjM="
 * const authHeader = jiraAuthHeader();
 * axios.get(url, { headers: { Authorization: authHeader } });
 */
function jiraAuthHeader(): string | null {
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) return null;

  const token = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString(
    "base64"
  );
  return `Basic ${token}`;
}

/**
 * ============================================================================
 * MCP Server Initialization
 * ============================================================================
 */

/**
 * MCP Server instance providing Atlassian/Jira integration tools.
 * Configured to communicate via stdio transport for cross-platform compatibility.
 */
const server = new McpServer({
  name: "custom-atlassian-mcp",
  version: "1.0.0",
});

/**
 * ============================================================================
 * Tool Registrations
 * ============================================================================
 */

/**
 * Tool: jira_get_issue_attachments
 *
 * Retrieves metadata for all attachments associated with a Jira issue.
 * Returns a list of attachment details including ID, MIME type, and filename.
 *
 * Use Case:
 * - Get a list of attachments before downloading specific ones
 * - Check attachment types and filenames
 * - Prepare for bulk attachment operations
 *
 * Error Handling:
 * - Returns error message for HTTP errors (4xx, 5xx)
 * - Handles network failures gracefully
 * - Returns empty array if issue has no attachments
 *
 * API Endpoint: GET /rest/api/3/issue/{issueId}?fields=attachment
 * Jira Cloud Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-get
 */
server.registerTool(
  "jira_get_issue_attachments",
  {
    title: "Get Jira Issue Attachments",
    description: "Get attachments of a Jira issue",
    inputSchema: {
      issueId: z.string().describe("The issue id"),
    },
  },
  async (args) => {
    try {
      // Construct Jira API endpoint, requesting only attachment field to minimize response size
      const url = `https://${JIRA_DOMAIN}/rest/api/3/issue/${args.issueId}?fields=attachment`;

      const r = await axios.get(url, {
        headers: {
          Authorization: jiraAuthHeader(),
          Accept: "application/json",
        },
        responseType: "json",
        // Accept all HTTP status codes to handle errors gracefully
        validateStatus: () => true,
      });

      // Handle non-successful HTTP responses
      if (r.status !== 200) {
        const errorMessage =
          r.data?.errorMessages?.join(", ") ||
          r.data?.message ||
          "Unknown error";
        return {
          content: [
            {
              type: "text",
              text: `Error ${r.status}: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }

      // Safely extract attachments array with fallback to empty array
      const attachments =
        (r.data && r.data.fields && r.data.fields.attachment) || [];

      // Map to simplified attachment metadata structure
      const attachmentDetails = attachments.map((attachment: any) => ({
        id: attachment.id,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
      }));

      // Return formatted JSON response
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(attachmentDetails, null, 2),
          },
        ],
      };
    } catch (error) {
      // Handle network errors and unexpected failures
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        content: [
          {
            type: "text",
            text: `Failed to fetch attachments: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * Tool: jira_get_attachment_image
 *
 * Downloads and returns the binary content of Jira attachments as base64-encoded images.
 * Supports batch processing of multiple attachments in a single request.
 *
 * Use Case:
 * - Display attachment images in UI
 * - Download multiple attachments efficiently
 * - Process attachment content programmatically
 *
 * Error Handling:
 * - Silently skips attachments that fail to download (returns successful ones only)
 * - Handles network errors per attachment without failing entire request
 * - Returns empty content array if all attachments fail
 *
 * API Endpoint: GET /rest/api/3/attachment/content/{attachmentId}
 * Jira Cloud Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-attachments/#api-rest-api-3-attachment-content-id-get
 *
 * Note: Despite the tool name suggesting "image", this can retrieve any attachment type.
 * The mimeType is currently hardcoded to "image/png" but actual content may vary.
 */
server.registerTool(
  "jira_get_attachment_image",
  {
    title: "Get Jira Attachment Image",
    description: "Get image of a Jira attachment",
    inputSchema: {
      attachmentIds: z.array(z.string()).describe("The attachment ids"),
    },
  },
  async (args) => {
    // Process all attachment downloads in parallel for performance
    const imagePromises = args.attachmentIds.map(
      async (attachmentId: string) => {
        try {
          const url = `https://${JIRA_DOMAIN}/rest/api/3/attachment/content/${attachmentId}`;

          const r = await axios.get(url, {
            headers: {
              Authorization: jiraAuthHeader(),
              Accept: "*/*", // Accept any content type
            },
            responseType: "arraybuffer", // Critical: Get binary data, not parsed JSON
            validateStatus: () => true,
          });

          // Only process successful responses with data
          if (r.status === 200 && r.data) {
            const base64 = Buffer.from(r.data).toString("base64");
            return { attachmentId, base64 };
          }
          // Returns undefined for non-200 responses
          return undefined;
        } catch (error) {
          // Silently skip attachments that fail due to network errors
          // This allows partial success when fetching multiple attachments
          return undefined;
        }
      }
    );

    // Wait for all downloads to complete
    const results = await Promise.all(imagePromises);

    // Filter out failed requests and format response
    return {
      content: results
        .filter((r) => r !== undefined)
        .map((imageResult) => ({
          type: "image",
          data: imageResult.base64,
          mimeType: "image/png", // TODO: Detect actual MIME type from response headers
        })),
    };
  }
);

/**
 * ============================================================================
 * Server Initialization & Startup
 * ============================================================================
 */

/**
 * Main server initialization function.
 *
 * Establishes stdio-based transport for MCP communication and starts the server.
 * The server will listen for tool invocation requests on stdin and respond on stdout.
 *
 * Error Handling:
 * - Logs startup errors to stderr
 * - Exits process with error code on failure
 * - Ensures server doesn't run in a broken state
 */
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Server is now running and listening for requests
    // No explicit logging to avoid polluting stdio communication channel
  } catch (error) {
    // Log fatal errors to stderr (won't interfere with stdio protocol)
    console.error("[FATAL] Failed to start MCP server:", error);
    process.exit(1);
  }
}

// Initialize and start the server
main();
