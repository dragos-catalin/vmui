import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";
import { espAuthorized } from "@/lib/esp/auth";
import { IS_LINUX } from "@/lib/runtime-os";
import { NextResponse, type NextRequest } from "next/server";
import { execFile } from "node:child_process";
import { z } from "zod";

export const dynamic = "force-dynamic";

// The Pi's own services, for the phone's "Pi" page. vmui runs on homepi under
// systemd; the units below are the ones pi/*.service install. Restart needs
// sudo: pi-deploy grants `dragos` NOPASSWD for `systemctl restart <these>`.
const UNITS = ["vmui", "turzx", "desk-button", "hub-cast", "caddy", "tailscaled", "docker"] as const;
const CONTAINERS = ["homeassistant", "esphome", "mosquitto"] as const;

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (_e, out, err) => resolve(String(out || err || "").trim()));
  });
}

export async function GET(req: NextRequest) {
  if (!espAuthorized(req)) return new NextResponse("forbidden", { status: 403 });
  if (!IS_LINUX) return NextResponse.json({ units: [], containers: [], note: "not on the Pi" });
  const log = new URL(req.url).searchParams.get("log");
  if (log) {
    if (!(UNITS as readonly string[]).includes(log) && !(CONTAINERS as readonly string[]).includes(log)) return NextResponse.json({ error: "unknown log" }, { status: 400 });
    const text = (CONTAINERS as readonly string[]).includes(log)
      ? await run("docker", ["logs", "--tail", "150", log])
      : await run("journalctl", ["-u", log, "-n", "150", "--no-pager", "-o", "short-iso"]);
    return NextResponse.json({ log, text }, { headers: { "Cache-Control": "no-store" } });
  }
  const [active, sub, dockerPs, up, temp, throttled, mem, disk] = await Promise.all([
    run("systemctl", ["is-active", ...UNITS]),
    run("systemctl", ["show", ...UNITS, "-p", "Id,ActiveEnterTimestamp,NRestarts", "--value"]),
    run("docker", ["ps", "-a", "--format", "{{.Names}}|{{.Status}}"]),
    run("cat", ["/proc/uptime"]),
    run("vcgencmd", ["measure_temp"]),
    run("vcgencmd", ["get_throttled"]),
    run("free", ["-m"]),
    run("df", ["-h", "/"]),
  ]);
  const states = active.split("\n");
  const units = UNITS.map((u, i) => ({ name: u, status: states[i] ?? "unknown", running: states[i] === "active" }));
  const containers = dockerPs.split("\n").filter(Boolean).map((l) => { const [name, status] = l.split("|"); return { name: name ?? "", status: status ?? "", running: (status ?? "").startsWith("Up") }; }).filter((c) => (CONTAINERS as readonly string[]).includes(c.name));
  const memLine = mem.split("\n")[1]?.split(/\s+/) ?? [];
  const diskLine = disk.split("\n")[1]?.split(/\s+/) ?? [];
  return NextResponse.json(
    {
      units,
      containers,
      uptimeSec: Math.round(Number(up.split(" ")[0] ?? 0)),
      tempC: Number((temp.match(/([\d.]+)/) ?? [])[1] ?? NaN),
      throttled: throttled.split("=")[1] ?? null,
      mem: { usedMB: Number(memLine[2] ?? 0), totalMB: Number(memLine[1] ?? 0) },
      disk: { used: diskLine[2] ?? "", size: diskLine[1] ?? "", pct: diskLine[4] ?? "" },
      restartsRaw: sub,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const body = z.object({ unit: z.enum(UNITS), action: z.enum(["restart", "start", "stop"]) });

export async function POST(req: NextRequest) {
  if (!espAuthorized(req)) return new NextResponse("forbidden", { status: 403 });
  const p = body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });
  if (p.data.unit === "vmui" && p.data.action !== "restart") return NextResponse.json({ ok: false, error: "vmui: only restart" }, { status: 400 });
  const out = await run("sudo", ["-n", "systemctl", p.data.action, p.data.unit], 20000);
  await db.insert(auditLog).values({ accountId: "mobile", action: `pi.${p.data.action}`, target: p.data.unit, status: "ok", message: out.slice(0, 300) });
  return NextResponse.json({ ok: true, out });
}
