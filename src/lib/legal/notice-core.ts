// Pure NOTICE logic shared by scripts/notice.mjs (Node strips the types at run time) and the
// vitest suite. Erasable TypeScript only: no enums, namespaces or parameter properties.

/** Licences a production dependency may carry. An SPDX expression passes when every AND term
 *  is allowed and at least one OR branch is allowed. OFL-1.1, MIT-0 and Zlib were added after
 *  the first scan (fonts, nodemailer, pako): permissive, owner to confirm (docs/legal/LAWYER-CHECKLIST.md). */
export const ALLOWED_LICENSES: readonly string[] = [
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
  "MPL-2.0",
  "Python-2.0",
  "CC-BY-4.0",
  "AGPL-3.0",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "LGPL-3.0-or-later",
  "OFL-1.1",
  "Zlib",
];

/** Packages whose metadata is wrong or missing, checked by hand against the shipped licence file. */
export const LICENSE_OVERRIDES: Readonly<Record<string, { license: string; reason: string }>> = {
  "thirty-two@1.0.2": { license: "MIT", reason: "package.json has no licence field; LICENSE.txt is the MIT text (Copyright (c) 2011, Chris Umbel)" },
};

export interface RawPackage {
  name: string;
  versions: string[];
  license: string;
  homepage?: string;
  repository?: string;
}

export interface NoticeEntry {
  name: string;
  version: string;
  license: string;
  url: string;
  overridden?: string;
}

type Node = { op: "id"; id: string } | { op: "and" | "or"; left: Node; right: Node };

function tokenize(expr: string): string[] {
  return expr.replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
}

/** Minimal SPDX expression parser: AND binds tighter than OR, parentheses, `X WITH exception` = X. */
export function parseSpdx(expr: string): Node | null {
  const tokens = tokenize(expr.trim());
  let i = 0;
  const peek = () => tokens[i];
  const primary = (): Node | null => {
    const tok = tokens[i++];
    if (tok === undefined) return null;
    if (tok === "(") {
      const inner = orExpr();
      if (tokens[i++] !== ")") return null;
      return inner;
    }
    if (tok === ")" || /^(AND|OR|WITH)$/i.test(tok)) return null;
    if (peek()?.toUpperCase() === "WITH") i += 2;
    return { op: "id", id: tok };
  };
  const andExpr = (): Node | null => {
    let left = primary();
    while (left && peek()?.toUpperCase() === "AND") {
      i++;
      const right = primary();
      if (!right) return null;
      left = { op: "and", left, right };
    }
    return left;
  };
  const orExpr = (): Node | null => {
    let left = andExpr();
    while (left && peek()?.toUpperCase() === "OR") {
      i++;
      const right = andExpr();
      if (!right) return null;
      left = { op: "or", left, right };
    }
    return left;
  };
  const tree = orExpr();
  return tree && i === tokens.length ? tree : null;
}

function evaluate(n: Node, allowed: ReadonlySet<string>): boolean {
  if (n.op === "id") return allowed.has(n.id.replace(/\+$/, ""));
  if (n.op === "and") return evaluate(n.left, allowed) && evaluate(n.right, allowed);
  return evaluate(n.left, allowed) || evaluate(n.right, allowed);
}

/** True when the licence (an SPDX id or expression) is acceptable under the allow-list. */
export function isLicenseAllowed(license: string, allowList: readonly string[] = ALLOWED_LICENSES): boolean {
  if (!license || /^(unknown|unlicensed|see license in)/i.test(license.trim())) return false;
  const tree = parseSpdx(license);
  return tree ? evaluate(tree, new Set(allowList)) : false;
}

/** Native per-OS builds (esbuild, swc, sharp, …) differ between Windows and the Linux CI runner;
 *  they are licence-checked but kept out of NOTICE.md so the file is the same on every machine. */
export function isPlatformPackage(name: string): boolean {
  return /(^|[-/])(win32|linux|darwin|android|freebsd|openbsd|sunos|wasm32)([-/]|$)/.test(name) || name.startsWith("@img/sharp-libvips");
}

export function normalizeRepoUrl(repo: string | undefined): string | undefined {
  if (!repo) return undefined;
  let url = repo.trim().replace(/^git\+/, "").replace(/\.git$/, "");
  if (/^git:\/\//.test(url)) url = url.replace(/^git:\/\//, "https://");
  if (/^git@github\.com:/.test(url)) url = url.replace(/^git@github\.com:/, "https://github.com/");
  if (/^github:/.test(url)) url = url.replace(/^github:/, "https://github.com/");
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return /^https?:\/\//.test(url) ? url : undefined;
}

/** pnpm `licenses list --json` → flat, sorted, override-applied entries. */
export function flattenLicenses(byLicense: Record<string, RawPackage[]>): NoticeEntry[] {
  const out: NoticeEntry[] = [];
  for (const [group, pkgs] of Object.entries(byLicense)) {
    for (const p of pkgs) {
      for (const version of p.versions) {
        const key = `${p.name}@${version}`;
        const override = LICENSE_OVERRIDES[key];
        const license = override?.license ?? (p.license || group);
        const url = normalizeRepoUrl(p.repository) ?? p.homepage ?? `https://www.npmjs.com/package/${p.name}`;
        out.push({ name: p.name, version, license, url, ...(override ? { overridden: override.reason } : {}) });
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
}

export interface LicenseViolation {
  name: string;
  version: string;
  license: string;
}

export function findViolations(entries: readonly NoticeEntry[], allowList: readonly string[] = ALLOWED_LICENSES): LicenseViolation[] {
  return entries.filter((e) => !isLicenseAllowed(e.license, allowList)).map(({ name, version, license }) => ({ name, version, license }));
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** Deterministic NOTICE.md: no dates, no machine paths, grouped by licence. */
export function renderNotice(entries: readonly NoticeEntry[]): string {
  const shipped = entries.filter((e) => !isPlatformPackage(e.name));
  const groups = new Map<string, NoticeEntry[]>();
  for (const e of shipped) groups.set(e.license, [...(groups.get(e.license) ?? []), e]);
  const order = [...groups.keys()].sort((a, b) => (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0) || a.localeCompare(b, "en"));
  const lines: string[] = [
    "# Third-party notices",
    "",
    "<!-- Generated by `node scripts/notice.mjs` from `pnpm licenses list --prod --json`. Do not edit by hand; CI runs `node scripts/notice.mjs --check`. -->",
    "",
    "Vatra (the hub) is free software under the GNU Affero General Public License v3.0 (see LICENSE).",
    "It includes the open-source packages below, each under its own licence. Native per-platform",
    "builds of these packages (esbuild, swc, sharp/libvips, …) are licence-checked but not listed.",
    "",
    `Packages: ${shipped.length}`,
    "",
  ];
  for (const lic of order) {
    const rows = groups.get(lic) ?? [];
    lines.push(`## ${lic} (${rows.length})`, "", "| Package | Version | Licence | Source |", "| --- | --- | --- | --- |");
    for (const r of rows) lines.push(`| ${cell(r.name)} | ${cell(r.version)} | ${cell(r.license)} | ${cell(r.url)} |`);
    lines.push("");
  }
  const overridden = shipped.filter((e) => e.overridden);
  if (overridden.length) {
    lines.push("## Licence metadata corrected by hand", "");
    for (const o of overridden) lines.push(`- ${o.name}@${o.version}: ${o.overridden}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface NoticeGroup {
  license: string;
  packages: Array<{ name: string; version: string; url: string }>;
}

/** Reads NOTICE.md back for the /licenses page. */
export function parseNoticeMarkdown(md: string): NoticeGroup[] {
  const groups: NoticeGroup[] = [];
  let current: NoticeGroup | null = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^## (.+?) \(\d+\)$/.exec(line);
    if (h?.[1]) {
      current = { license: h[1], packages: [] };
      groups.push(current);
      continue;
    }
    if (line.startsWith("## ")) {
      current = null;
      continue;
    }
    if (!current || !line.startsWith("|") || line.startsWith("| Package") || line.startsWith("| ---")) continue;
    const cells = line.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
    const [name, version, , url] = cells;
    if (name && version) current.packages.push({ name, version, url: url ?? "" });
  }
  return groups;
}

export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").trimEnd() + "\n";
}
