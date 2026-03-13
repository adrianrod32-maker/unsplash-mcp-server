/**
 * Unsplash MCP Server — Single File, Ready for Glitch
 * Paste this file + package.json into Glitch and set UNSPLASH_ACCESS_KEY in environment variables.
 *
 * Get your free API key at: https://unsplash.com/developers
 * (Create an app → copy the "Access Key")
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import axios from "axios";
import { z } from "zod";

// ─── Config ──────────────────────────────────────────────────────────────────

const ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const PORT = process.env.PORT || 3000;
const BASE_URL = "https://api.unsplash.com";

if (!ACCESS_KEY) {
  console.warn("WARNING: UNSPLASH_ACCESS_KEY environment variable is not set — API calls will return errors until configured in Railway Variables tab");
}

// ─── Unsplash API Client ──────────────────────────────────────────────────────

async function unsplashGet(endpoint, params = {}) {
  try {
    const res = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: {
        Authorization: `Client-ID ${ACCESS_KEY}`,
        "Accept-Version": "v1"
      },
      params,
      timeout: 15000
    });
    return res.data;
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      if (status === 401) throw new Error("Invalid Unsplash access key — check your UNSPLASH_ACCESS_KEY");
      if (status === 403) throw new Error("Rate limit exceeded or access forbidden");
      if (status === 404) throw new Error("Resource not found on Unsplash");
      if (status === 429) throw new Error("Rate limit hit — Unsplash allows 50 requests/hour on free tier");
      throw new Error(`Unsplash API error ${status}: ${err.response.data?.errors?.join(", ") || "unknown"}`);
    }
    throw new Error(`Network error: ${err.message}`);
  }
}

// Helper to format a photo object into readable text
function formatPhoto(p) {
  const credit = p.user ? `${p.user.name} (@${p.user.username})` : "Unknown";
  const desc = p.description || p.alt_description || "No description";
  const tags = p.tags?.map(t => t.title).join(", ") || "none";
  const dims = `${p.width}×${p.height}px`;
  const color = p.color || "N/A";
  const likes = p.likes ?? 0;
  const downloads = p.downloads ?? "N/A";
  const downloadUrl = p.urls?.full || p.links?.download || "N/A";
  const thumbUrl = p.urls?.thumb || "N/A";

  return (
    `📷 **${p.id}** — ${desc}\n` +
    `   Photographer: ${credit}\n` +
    `   Dimensions: ${dims} | Color: ${color}\n` +
    `   Likes: ${likes} | Downloads: ${downloads}\n` +
    `   Tags: ${tags}\n` +
    `   Full URL: ${downloadUrl}\n` +
    `   Thumb: ${thumbUrl}`
  );
}

// ─── Build MCP Server ─────────────────────────────────────────────────────────

function buildServer() {
  const server = new McpServer({ name: "unsplash-mcp-server", version: "1.0.0" });

  // Tool 1 — Search Photos
  server.registerTool(
    "unsplash_search_photos",
    {
      title: "Search Unsplash Photos",
      description: `Search Unsplash for photos matching a keyword or phrase.
Returns up to 20 results per page with photo IDs, descriptions, photographer credits,
dimensions, dominant color, tags, and direct download URLs.

Args:
  - query: Search keywords (e.g. "wine vineyard sunset", "oak barrels cellar")
  - per_page: Results per page (1–20, default 10)
  - page: Page number for pagination (default 1)
  - orientation: 'landscape', 'portrait', or 'squarish' (optional)
  - color: Filter by color — 'black_and_white', 'black', 'white', 'yellow', 'orange', 'red', 'purple', 'magenta', 'green', 'teal', 'blue' (optional)
  - order_by: 'relevant' (default) or 'latest'

Returns: list of matching photos with metadata and download links.`,
      inputSchema: z.object({
        query: z.string().min(1).describe("Search keywords"),
        per_page: z.number().int().min(1).max(20).default(10).describe("Results per page (max 20)"),
        page: z.number().int().min(1).default(1).describe("Page number"),
        orientation: z.enum(["landscape", "portrait", "squarish"]).optional().describe("Photo orientation filter"),
        color: z.enum(["black_and_white", "black", "white", "yellow", "orange", "red", "purple", "magenta", "green", "teal", "blue"]).optional().describe("Dominant color filter"),
        order_by: z.enum(["relevant", "latest"]).default("relevant").describe("Sort order")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ query, per_page, page, orientation, color, order_by }) => {
      try {
        const params = { query, per_page, page, order_by };
        if (orientation) params.orientation = orientation;
        if (color) params.color = color;

        const result = await unsplashGet("/search/photos", params);
        const total = result.total ?? 0;
        const photos = result.results ?? [];

        if (photos.length === 0) {
          return { content: [{ type: "text", text: `No photos found for "${query}".` }] };
        }

        const lines = [
          `🔍 Search: "${query}" — ${total} total results (page ${page})`,
          `Showing ${photos.length} photos:\n`,
          ...photos.map((p, i) => `${i + 1}. ${formatPhoto(p)}`)
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  // Tool 2 — Get Photo Details
  server.registerTool(
    "unsplash_get_photo",
    {
      title: "Get Photo Details",
      description: `Fetch full metadata for a specific Unsplash photo by its ID.
Returns complete details: description, photographer, dimensions, color palette,
EXIF camera data, tags, view/download stats, and all image URL variants
(raw, full, regular, small, thumb).

Args:
  - photo_id: Unsplash photo ID (e.g. "abc123xyz")

Returns: full photo metadata including all download URLs and stats.`,
      inputSchema: z.object({
        photo_id: z.string().min(1).describe("Unsplash photo ID")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ photo_id }) => {
      try {
        const p = await unsplashGet(`/photos/${photo_id}`);

        const exif = p.exif
          ? `Camera: ${p.exif.make || "?"} ${p.exif.model || "?"} | ISO ${p.exif.iso || "?"} | f/${p.exif.aperture || "?"} | ${p.exif.exposure_time || "?"}s | ${p.exif.focal_length || "?"}mm`
          : "EXIF data not available";

        const palette = p.color ? `Dominant color: ${p.color}` : "";
        const tags = p.tags?.map(t => t.title).join(", ") || "none";
        const location = p.location?.name || p.location?.city || "Location not specified";

        const lines = [
          `📷 Photo: ${p.id}`,
          `Description: ${p.description || p.alt_description || "None"}`,
          `Photographer: ${p.user?.name} (@${p.user?.username})`,
          `  Portfolio: https://unsplash.com/@${p.user?.username}`,
          ``,
          `Dimensions: ${p.width}×${p.height}px`,
          palette,
          `Location: ${location}`,
          ``,
          exif,
          ``,
          `Stats:`,
          `  Views: ${p.views?.toLocaleString() ?? "N/A"}`,
          `  Downloads: ${p.downloads?.toLocaleString() ?? "N/A"}`,
          `  Likes: ${p.likes ?? 0}`,
          ``,
          `Tags: ${tags}`,
          ``,
          `Image URLs:`,
          `  Raw (original): ${p.urls?.raw}`,
          `  Full: ${p.urls?.full}`,
          `  Regular (1080px): ${p.urls?.regular}`,
          `  Small (400px): ${p.urls?.small}`,
          `  Thumb (200px): ${p.urls?.thumb}`,
          ``,
          `Download link (triggers Unsplash download count): ${p.links?.download}`
        ].filter(l => l !== undefined);

        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: p };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  // Tool 3 — List Editorial Photos
  server.registerTool(
    "unsplash_list_photos",
    {
      title: "List Editorial Photos",
      description: `Browse Unsplash's editorial feed — curated, high-quality photos not tied to a keyword search.
Great for discovering trending or recently-added imagery.

Args:
  - per_page: Results per page (1–20, default 10)
  - page: Page number (default 1)
  - order_by: 'latest' (default), 'oldest', or 'popular'

Returns: list of photos with metadata and download URLs.`,
      inputSchema: z.object({
        per_page: z.number().int().min(1).max(20).default(10).describe("Results per page"),
        page: z.number().int().min(1).default(1).describe("Page number"),
        order_by: z.enum(["latest", "oldest", "popular"]).default("latest").describe("Sort order")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ per_page, page, order_by }) => {
      try {
        const photos = await unsplashGet("/photos", { per_page, page, order_by });

        if (!photos || photos.length === 0) {
          return { content: [{ type: "text", text: "No photos returned." }] };
        }

        const lines = [
          `📚 Editorial feed — ${order_by} (page ${page})\n`,
          ...photos.map((p, i) => `${i + 1}. ${formatPhoto(p)}`)
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  // Tool 4 — Trigger Download
  server.registerTool(
    "unsplash_trigger_download",
    {
      title: "Trigger Photo Download",
      description: `Trigger the official Unsplash download event for a photo (required by Unsplash API guidelines
when a user actually downloads/uses an image). Returns the direct download URL.

Per Unsplash API terms: call this before saving or embedding a photo.

Args:
  - photo_id: Unsplash photo ID

Returns: direct download URL for the full-resolution image.`,
      inputSchema: z.object({
        photo_id: z.string().min(1).describe("Unsplash photo ID")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ photo_id }) => {
      try {
        const result = await unsplashGet(`/photos/${photo_id}/download`);
        const url = result.url || result;
        const text = `✅ Download triggered for photo ${photo_id}\n\nDirect download URL:\n${url}`;
        return { content: [{ type: "text", text }], structuredContent: { photo_id, url } };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  // Tool 5 — Search Users
  server.registerTool(
    "unsplash_search_users",
    {
      title: "Search Unsplash Photographers",
      description: `Search for Unsplash photographers/users by name.
Useful for finding photographers who specialize in a subject (e.g. wine, food, travel).

Args:
  - query: Photographer name or keyword
  - per_page: Results per page (1–20, default 10)
  - page: Page number (default 1)

Returns: list of photographers with profile links, bio, and photo counts.`,
      inputSchema: z.object({
        query: z.string().min(1).describe("Photographer name or keyword"),
        per_page: z.number().int().min(1).max(20).default(10).describe("Results per page"),
        page: z.number().int().min(1).default(1).describe("Page number")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ query, per_page, page }) => {
      try {
        const result = await unsplashGet("/search/users", { query, per_page, page });
        const users = result.results ?? [];
        const total = result.total ?? 0;

        if (users.length === 0) {
          return { content: [{ type: "text", text: `No photographers found for "${query}".` }] };
        }

        const lines = [
          `👤 Photographers matching "${query}" — ${total} total\n`,
          ...users.map((u, i) => {
            const bio = u.bio ? u.bio.slice(0, 120) + (u.bio.length > 120 ? "…" : "") : "No bio";
            return (
              `${i + 1}. ${u.name} (@${u.username})\n` +
              `   Photos: ${u.total_photos} | Likes: ${u.total_likes}\n` +
              `   Bio: ${bio}\n` +
              `   Profile: https://unsplash.com/@${u.username}`
            );
          })
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  // Tool 6 — Get User Profile
  server.registerTool(
    "unsplash_get_user",
    {
      title: "Get Photographer Profile",
      description: `Fetch a photographer's full Unsplash profile by username.
Returns bio, location, social links, follower counts, and photo/collection stats.

Args:
  - username: Unsplash username (without @)

Returns: full profile metadata.`,
      inputSchema: z.object({
        username: z.string().min(1).describe("Unsplash username (without @)")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ username }) => {
      try {
        const u = await unsplashGet(`/users/${username}`);

        const social = [];
        if (u.social?.instagram_username) social.push(`Instagram: @${u.social.instagram_username}`);
        if (u.social?.twitter_username) social.push(`Twitter: @${u.social.twitter_username}`);
        if (u.social?.portfolio_url) social.push(`Portfolio: ${u.social.portfolio_url}`);

        const lines = [
          `👤 ${u.name} (@${u.username})`,
          `Location: ${u.location || "Not specified"}`,
          ``,
          `Bio: ${u.bio || "No bio"}`,
          ``,
          `Stats:`,
          `  Photos: ${u.total_photos}`,
          `  Collections: ${u.total_collections}`,
          `  Likes given: ${u.total_likes}`,
          `  Followers: ${u.followers_count?.toLocaleString() ?? "N/A"}`,
          `  Following: ${u.following_count?.toLocaleString() ?? "N/A"}`,
          ``,
          `Profile: https://unsplash.com/@${u.username}`,
          ...(social.length ? [`\nSocial:`, ...social.map(s => `  ${s}`)] : [])
        ];

        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: u };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  // Tool 7 — List User Photos
  server.registerTool(
    "unsplash_list_user_photos",
    {
      title: "List Photographer's Photos",
      description: `Browse photos uploaded by a specific Unsplash photographer.
Great for finding all work from a photographer you like.

Args:
  - username: Unsplash username (without @)
  - per_page: Results per page (1–20, default 10)
  - page: Page number (default 1)
  - order_by: 'latest' (default), 'oldest', or 'popular'

Returns: list of the photographer's photos with metadata and download URLs.`,
      inputSchema: z.object({
        username: z.string().min(1).describe("Unsplash username (without @)"),
        per_page: z.number().int().min(1).max(20).default(10).describe("Results per page"),
        page: z.number().int().min(1).default(1).describe("Page number"),
        order_by: z.enum(["latest", "oldest", "popular"]).default("latest").describe("Sort order")
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ username, per_page, page, order_by }) => {
      try {
        const photos = await unsplashGet(`/users/${username}/photos`, { per_page, page, order_by, stats: true });

        if (!photos || photos.length === 0) {
          return { content: [{ type: "text", text: `No photos found for @${username}.` }] };
        }

        const lines = [
          `📷 Photos by @${username} — ${order_by} (page ${page})\n`,
          ...photos.map((p, i) => `${i + 1}. ${formatPhoto(p)}`)
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    }
  );

  return server;
}

// ─── HTTP Server (Streamable HTTP for Claude connector) ───────────────────────

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "unsplash-mcp-server" });
});

app.all("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on("close", () => transport.close());
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`✅ Unsplash MCP server running on port ${PORT}`);
  console.log(`   Connect Claude at: https://YOUR-PROJECT.glitch.me/mcp`);
});
