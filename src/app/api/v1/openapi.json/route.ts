import "server-only";

const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Vatra public API",
    version: "1.0.0",
    description:
      "Authenticated bearer-token API for vmui. Create keys at /settings/api-keys.",
  },
  servers: [{ url: "http://127.0.0.1:3737" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "vmui_*" },
      deviceAuth: { type: "http", scheme: "bearer", bearerFormat: "vmd_*", description: "Paired device token (POST /api/devices/pair)." },
    },
  },
  paths: {
    "/api/v1/me/health": {
      get: {
        summary: "The owner's health readings and nutrition totals (for the Vitals apps)",
        description:
          "Owner's paired devices only. Token in the Authorization header, never in the URL. Every reading is null when not measured. Meals, coach messages and hydration entries are not included. Never cached.",
        security: [{ deviceAuth: [] }],
        responses: {
          "200": { description: "OK: { at, health, nutrition }" },
          "401": { description: "Missing, unknown or revoked device token" },
          "403": { description: "Device belongs to a member who is not the owner" },
        },
      },
    },
    "/api/v1/instances": {
      get: {
        summary: "List cached instances across all accounts",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", maximum: 500, default: 100 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/api/v1/instances/{id}/{action}": {
      post: {
        summary: "Run a power action against an instance (operator role)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          {
            name: "action",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["start", "stop", "reboot", "terminate"] },
          },
        ],
        responses: {
          "200": { description: "OK" },
          "400": { description: "Bad action / provider error" },
          "401": { description: "Unauthorized" },
          "403": { description: "Operator role required" },
          "404": { description: "Instance not found" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/api/v1/accounts": {
      get: {
        summary: "List cloud accounts",
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/api/v1/audit": {
      get: {
        summary: "Search the audit log",
        parameters: [
          { name: "q", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["ok", "error"] } },
          { name: "account", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 500, default: 50 } },
        ],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/api/v1/backups/policies": {
      get: {
        summary: "List backup policies",
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/api/v1/backups/jobs": {
      get: {
        summary: "List recent backup jobs (most recent first)",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", maximum: 500, default: 50 } },
        ],
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/api/v1/gitops/sources": {
      get: {
        summary: "List GitOps sources",
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
    "/api/v1/secrets": {
      get: {
        summary: "List secret metadata (values are never returned)",
        responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } },
      },
    },
  },
} as const;

export function GET() {
  return Response.json(SPEC);
}
