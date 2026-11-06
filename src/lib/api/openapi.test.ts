import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// P3-02: the committed OpenAPI snapshot and the contract fixtures must match the route declarations.
// After an intended API change: UPDATE_OPENAPI=1 pnpm exec vitest run src/lib/api/openapi.test.ts
// (and bump API_VERSION / MIN_CLIENT in lib/api-version.ts when apps must notice).

vi.mock("@/lib/home/ha-client", () => ({ ha: {} }));
// the fixtures describe a sample house; the entity whitelist is the only house-dependent check
vi.mock("@/lib/home/house", () => ({ houseEntities: () => new Set(["light.bed_lamp"]), houseDevices: () => [], houseRooms: () => [] }));

const SNAPSHOT = "docs/api/app-openapi.json";
const FIXTURES = "docs/api/fixtures";

const { appOpenApi } = await import("./openapi");
const { APP_ROUTES } = await import("./app-routes");

describe("OpenAPI drift", () => {
  it("matches docs/api/app-openapi.json", () => {
    const now = `${JSON.stringify(appOpenApi(), null, 2)}\n`;
    if (process.env.UPDATE_OPENAPI === "1") {
      mkdirSync("docs/api", { recursive: true });
      writeFileSync(SNAPSHOT, now);
    }
    expect(existsSync(SNAPSHOT), `${SNAPSHOT} missing: run with UPDATE_OPENAPI=1`).toBe(true);
    expect(now).toBe(readFileSync(SNAPSHOT, "utf8").replace(/\r\n/g, "\n"));
  });

  it("declares every operation once with a unique id", () => {
    const ids = APP_ROUTES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = APP_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has a route file exporting each declared method", () => {
    for (const r of APP_ROUTES) {
      const file = join("src/app", r.path, "route.ts");
      expect(existsSync(file), file).toBe(true);
      expect(readFileSync(file, "utf8"), `${file} ${r.method}`).toMatch(new RegExp(`export const ${r.method} = handle\\(`));
    }
  });
});

describe("contract fixtures", () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith(".json"));

  it("cover every operation", () => {
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(APP_ROUTES.map((r) => r.id).sort());
  });

  for (const f of files) {
    it(`${f} validates against its route schemas`, () => {
      const id = f.replace(/\.json$/, "");
      const route = APP_ROUTES.find((r) => r.id === id);
      expect(route, id).toBeDefined();
      const fx = JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as { request?: unknown; response: unknown };
      if (fx.request !== undefined) expect(route?.input.safeParse(fx.request).success, `${id} request`).toBe(true);
      const out = route?.output.safeParse(fx.response);
      expect(out?.success, `${id} response: ${out?.error?.message ?? ""}`).toBe(true);
    });
  }
});
