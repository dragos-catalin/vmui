import "server-only";

import { apiText, type ApiErrorCode } from "@/lib/api-error";
import { API_VERSION } from "@/lib/api-version";
import { canOpenDoor, deviceHomeActor, isOwner, type HomeActor } from "@/lib/home/access";
import { NextResponse } from "next/server";
import { z } from "zod";

/**
 * /api/v1/app/* — the native apps' contract (P3-01). Each operation is declared once with
 * defineRoute: zod input (query for GET/DELETE, JSON body otherwise), zod output, and which
 * family members may call it. The declarations in lib/api/app-routes.ts are the single source
 * for the handlers AND the generated OpenAPI document (lib/api/openapi.ts).
 *
 * Auth: a paired device token in the Authorization header only (`Bearer vmd_…`), resolved to the
 * household member it is bound to. No query-string token, no shared house token, no cookie.
 */

export type RouteAuth = "member" | "owner" | "door";
export type Method = "GET" | "POST" | "PUT" | "DELETE";

/** Expected refusal from a handler: becomes `{ ok:false, code, error }` with the localised text. */
export class RouteError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

type Ctx<I extends z.ZodType> = { actor: HomeActor; input: z.output<I>; req: Request };

export type AppRoute<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = {
  id: string;
  method: Method;
  path: `/api/v1/app/${string}`;
  summary: string;
  description?: string;
  auth: RouteAuth;
  input: I;
  output: O;
  handler: (ctx: Ctx<I>) => Promise<z.input<O>>;
};

export const errorBodySchema = z.object({ ok: z.literal(false), code: z.string(), error: z.string(), detail: z.string().optional() });

const empty = z.object({});

export function defineRoute<O extends z.ZodType, I extends z.ZodType = typeof empty>(spec: Omit<AppRoute<I, O>, "input"> & { input?: I }): AppRoute<I, O> {
  return { ...spec, input: (spec.input ?? empty) as I };
}

const allowed: Record<RouteAuth, (a: HomeActor) => boolean> = { member: () => true, owner: isOwner, door: canOpenDoor };
const HEADERS = { "Cache-Control": "no-store", "x-vatra-api": String(API_VERSION) };

function fail(req: Request, code: ApiErrorCode, status: number, detail?: string): NextResponse {
  return NextResponse.json({ ok: false, code, error: apiText(req, code), ...(detail ? { detail } : {}) }, { status, headers: HEADERS });
}

async function readInput(req: Request, method: Method): Promise<unknown> {
  if (method === "GET" || method === "DELETE") return Object.fromEntries(new URL(req.url).searchParams);
  return (await req.json().catch(() => undefined)) ?? {};
}

/** The Next.js handler for one operation. */
export function handle<I extends z.ZodType, O extends z.ZodType>(route: AppRoute<I, O>): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!req.headers.get("authorization")?.startsWith("Bearer vmd_")) return fail(req, "unauthorized", 401);
    const actor = await deviceHomeActor(req);
    if (!actor) return fail(req, "not_bound", 403);
    if (!allowed[route.auth](actor)) return fail(req, "forbidden", 403);
    const parsed = route.input.safeParse(await readInput(req, route.method));
    if (!parsed.success) return fail(req, "invalid_request", 400, z.prettifyError(parsed.error));
    try {
      const out = await route.handler({ actor, input: parsed.data, req });
      return NextResponse.json(route.output.parse(out), { headers: HEADERS });
    } catch (e) {
      if (e instanceof RouteError) return fail(req, e.code, e.status);
      return fail(req, "upstream_failed", 502, e instanceof Error ? e.message.slice(0, 200) : undefined);
    }
  };
}
