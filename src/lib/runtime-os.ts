import { existsSync } from "node:fs";

// Turbopack constant-folds `process.platform` AND `os.platform()` at build time. The Pi
// runs a .next built on Windows, so a folded check picks the Windows branch forever
// (2026-10-18: /api/desktop/pi compiled to `return undefined` → 500). Probe the filesystem.
export const IS_LINUX = existsSync("/proc/version");
export const IS_WINDOWS = !IS_LINUX && existsSync("C:\\Windows\\System32");
