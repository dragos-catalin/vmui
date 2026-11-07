// Runs once when the Next.js server starts (nodejs runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // demo hub (P10-04): wipe + reseed before anything opens the db or the key; no-op otherwise
  await (await import("@/lib/demo/reset")).bootDemo();
  // a restore staged by /api/backup/restore swaps in before anything opens the db or the key (P5-06)
  (await import("@/lib/hub-restore-boot")).applyStagedRestore();
  // a fresh hub creates its master key at first boot, not at the first encrypted write (P2-04)
  (await import("@/lib/env")).requireMasterKey();
  // Encrypted integration secrets become visible to credential() (globalThis registry).
  await import("@/lib/integrations");
  // Unclaimed hub: print the setup code in the server log at boot.
  const { userCount } = await import("@/lib/auth");
  if ((await userCount()) === 0) (await import("@/lib/setup-code")).setupCode();
  // Vatra Cloud (P10): certificate renewal + relay tunnel when the owner enabled remote access
  (await import("@/lib/cloud")).startVatraCloud();
}
