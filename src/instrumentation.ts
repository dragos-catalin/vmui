// Runs once when the Next.js server starts (nodejs runtime only).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // a fresh hub creates its master key at first boot, not at the first encrypted write (P2-04)
  (await import("@/lib/env")).requireMasterKey();
  // Encrypted integration secrets become visible to credential() (globalThis registry).
  await import("@/lib/integrations");
  // Unclaimed hub: print the setup code in the server log at boot.
  const { userCount } = await import("@/lib/auth");
  if ((await userCount()) === 0) (await import("@/lib/setup-code")).setupCode();
}
