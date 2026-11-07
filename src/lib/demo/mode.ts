// Demo hub for store reviewers (P10-04): the hub image with VATRA_DEMO=1. Destructive or account-level
// operations call demoReadonly() first and refuse with 403 demo_readonly.
export const isDemo = (): boolean => process.env.VATRA_DEMO === "1";

export class DemoReadonly extends Error {
  readonly code = "demo_readonly";
  readonly status = 403;
  constructor() {
    super("demo_readonly");
    this.name = "DemoReadonly";
  }
}

export function demoReadonly(): void {
  if (isDemo()) throw new DemoReadonly();
}

/** For server actions that return `{ ok: false, error }`: `const d = demoRefusal(); if (d) return d;`. */
export function demoRefusal(): { ok: false; error: "demo_readonly" } | null {
  try {
    demoReadonly();
    return null;
  } catch (e) {
    if (e instanceof DemoReadonly) return { ok: false, error: e.code };
    throw e;
  }
}

/** For route handlers: the API error contract, 403 demo_readonly. */
export function demoRefusalResponse(): Response | null {
  const d = demoRefusal();
  return d ? Response.json({ ok: false, code: d.error, error: "Not available on the demo hub" }, { status: 403, headers: { "Cache-Control": "no-store" } }) : null;
}
