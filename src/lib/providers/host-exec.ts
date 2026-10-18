import "server-only";

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { IS_WINDOWS } from "@/lib/runtime-os";

const execFileP = promisify(execFile);

/**
 * Where the Windows/Hyper-V host is, relative to this process.
 *
 * - On the PC itself (`process.platform === "win32"`) commands run locally.
 * - On homepi, `VMUI_HOST_SSH=vladu@192.168.100.61` makes every host command
 *   an `ssh` hop. PowerShell scripts travel as `-EncodedCommand` (UTF-16LE
 *   base64) so no quoting survives three shells; wsl.exe argv is passed
 *   through unchanged because ssh hands it to the remote shell as-is.
 */
export const HOST_SSH = process.env.VMUI_HOST_SSH ?? "";
export const HOST_IS_LOCAL = IS_WINDOWS && !HOST_SSH;
export const HOST_AVAILABLE = HOST_IS_LOCAL || HOST_SSH.length > 0;

const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new"];

function encodePs(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function hostUnavailableError(): Error {
  return new Error("Hyper-V host not reachable: this vmui is not on the Windows host and VMUI_HOST_SSH is not set");
}

/** Run a PowerShell snippet on the Windows host; returns trimmed stdout. */
export async function hostPs(script: string, opts: { maxBuffer?: number; timeoutMs?: number } = {}): Promise<string> {
  const common = { maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024, encoding: "utf8" as const, windowsHide: true, timeout: opts.timeoutMs ?? 60_000 };
  if (HOST_IS_LOCAL) {
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], common);
    return stdout.replace(/\r/g, "").trim();
  }
  if (!HOST_SSH) throw hostUnavailableError();
  const { stdout } = await execFileP("ssh", [...SSH_OPTS, HOST_SSH, `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePs(script)}`], common);
  return stdout.replace(/\r/g, "").trim();
}

/** Run `bash -lc <cmd>` inside a WSL distro on the Windows host. */
export async function hostWsl(distro: string, cmd: string, opts: { maxBuffer?: number; timeoutMs?: number } = {}): Promise<string> {
  const common = { maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024, encoding: "utf8" as const, windowsHide: true, timeout: opts.timeoutMs ?? 60_000 };
  if (HOST_IS_LOCAL) {
    const { stdout } = await execFileP("wsl.exe", ["-d", distro, "--", "bash", "-lc", cmd], common);
    return stdout.replace(/\r/g, "").trim();
  }
  if (!HOST_SSH) throw hostUnavailableError();
  // ssh → Windows OpenSSH (cmd.exe) → wsl.exe → bash is three quoting layers,
  // and cmd.exe parses `|` and `<<` itself, so the command travels as a base64
  // ARGUMENT and the only pipe is escaped for cmd.exe with `^|`. Verified
  // from homepi: `nproc; echo "quoted ok"` round-trips intact.
  const b64 = Buffer.from(cmd, "utf8").toString("base64");
  const { stdout } = await execFileP("ssh", [...SSH_OPTS, HOST_SSH, `wsl.exe -d ${distro} -- bash -lc "eval \\"\\$(echo \\$1 ^| base64 -d)\\"" _ ${b64}`], common);
  return stdout.replace(/\r/g, "").trim();
}

/** Run an arbitrary Windows executable with argv on the host; returns stdout. */
export async function hostExe(file: string, args: string[], opts: { maxBuffer?: number; timeoutMs?: number } = {}): Promise<string> {
  const common = { maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024, encoding: "utf8" as const, windowsHide: true, timeout: opts.timeoutMs ?? 60_000 };
  if (HOST_IS_LOCAL) {
    const { stdout } = await execFileP(file, args, common);
    return stdout.replace(/\r/g, "").trim();
  }
  if (!HOST_SSH) throw hostUnavailableError();
  // PowerShell call operator with a literal argv array: cmd.exe never sees the
  // arguments, so `/TR "wsl.exe ... & disown"` survives untouched.
  const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const script = `& ${psq(file)} @(${args.map(psq).join(",")}); exit $LASTEXITCODE`;
  return hostPs(script, opts);
}

/**
 * Fire-and-forget a Windows process on the host (detached). Over ssh we use
 * `Start-Process` so the remote sshd session can end without killing it.
 */
export function hostSpawnDetached(file: string, args: string[]): ChildProcess | null {
  if (HOST_IS_LOCAL) {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    return child;
  }
  if (!HOST_SSH) throw hostUnavailableError();
  const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(",");
  const ps = `Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList @(${argList}) -WindowStyle Hidden`;
  const child = spawn("ssh", [...SSH_OPTS, HOST_SSH, `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePs(ps)}`], { stdio: "ignore", windowsHide: true });
  child.unref();
  return child;
}
