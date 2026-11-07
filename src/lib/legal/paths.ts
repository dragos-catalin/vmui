/** Public legal pages (P11-01). Kept in sync with PUBLIC_PREFIXES in src/proxy.ts. */
export const LEGAL_PATHS = ["/privacy", "/legal", "/licenses", "/account/delete"] as const;

export const isLegalPath = (path: string): boolean => LEGAL_PATHS.some((p) => path === p || path.startsWith(p + "/"));
