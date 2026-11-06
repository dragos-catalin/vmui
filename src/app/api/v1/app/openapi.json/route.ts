import { appOpenApi } from "@/lib/api/openapi";

export const dynamic = "force-static";

// GET /api/v1/app/openapi.json — the native apps' contract, generated from lib/api/app-routes.ts.
export function GET() {
  return Response.json(appOpenApi());
}
