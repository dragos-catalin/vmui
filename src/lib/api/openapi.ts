import "server-only";

import { API_VERSION, MIN_CLIENT } from "@/lib/api-version";
import { z } from "zod";
import { APP_ROUTES } from "./app-routes";
import { errorBodySchema, type AppRoute } from "./define-route";

/** OpenAPI 3.1 for /api/v1/app, generated from the route declarations (P3-02).
 *  Snapshot: docs/api/app-openapi.json — the drift test fails when a route changes without it. */

const AUTH_TEXT: Record<AppRoute["auth"], string> = {
  member: "Any household member's paired device; room grants apply.",
  owner: "Only the owner's devices.",
  door: "Only owner or adult devices.",
};

const schema = (s: z.ZodType, io: "input" | "output") => z.toJSONSchema(s, { target: "draft-2020-12", io, unrepresentable: "any", reused: "inline" });

const errorRef = { $ref: "#/components/schemas/Error" };
const err = (description: string) => ({ description, content: { "application/json": { schema: errorRef } } });

function operation(r: AppRoute) {
  const isQuery = r.method === "GET" || r.method === "DELETE";
  const input = schema(r.input, "input") as { properties?: Record<string, object>; required?: string[] };
  return {
    operationId: r.id,
    summary: r.summary,
    description: [r.description, AUTH_TEXT[r.auth]].filter(Boolean).join("\n\n"),
    tags: ["app"],
    security: [{ deviceAuth: [] }],
    ...(isQuery
      ? {
          parameters: Object.entries(input.properties ?? {}).map(([name, s]) => ({ name, in: "query", required: input.required?.includes(name) ?? false, schema: s })),
        }
      : { requestBody: { required: true, content: { "application/json": { schema: input } } } }),
    responses: {
      "200": { description: "OK", content: { "application/json": { schema: schema(r.output, "output") } } },
      ...(isQuery ? {} : { "400": err("invalid_request: the body does not match the schema") }),
      "401": err("unauthorized: no `Authorization: Bearer vmd_…` header"),
      "403": err("not_bound / forbidden / no_room_access"),
      ...(r.method === "GET" ? {} : { "502": err("upstream_failed: Home Assistant did not carry out the command") }),
    },
  };
}

export function appOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of APP_ROUTES) (paths[r.path] ??= {})[r.method.toLowerCase()] = operation(r);
  return {
    openapi: "3.1.0",
    info: {
      title: "Vatra app API",
      version: `${API_VERSION}.0.0`,
      description: `Contract between the Vatra hub and its native apps. apiVersion ${API_VERSION}, minClient ${MIN_CLIENT} (GET /api/discover). Errors are { ok:false, code, error } with \`error\` in the device language (Accept-Language or x-vatra-locale).`,
    },
    servers: [{ url: "http://vatra.local:3737" }],
    components: {
      securitySchemes: { deviceAuth: { type: "http", scheme: "bearer", bearerFormat: "vmd_*", description: "Paired device token (POST /api/devices/pair). Header only, never in the URL." } },
      schemas: { Error: schema(errorBodySchema, "output") },
    },
    paths,
  };
}
