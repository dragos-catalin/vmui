import "server-only";

/** Publisher identity and contacts shown on /privacy, /legal, /licenses and /account/delete.
 *  Values marked PLACEHOLDER must be confirmed by the owner before store launch
 *  (docs/legal/LAWYER-CHECKLIST.md, "Placeholders"). Env overrides let a fork publish its own. */
export const PLACEHOLDER_POSTAL = "[P.O. box — owner to fill before store launch]";

export interface LegalConfig {
  publisher: string;
  country: string;
  /** PLACEHOLDER until the owner confirms the mailbox. */
  privacyEmail: string;
  /** PLACEHOLDER until the owner confirms the mailbox. */
  securityEmail: string;
  postal: string;
  phone: string;
  sourceUrl: string;
  version: string | null;
  commit: string | null;
  /** True while any contact value is still the default placeholder. */
  placeholders: boolean;
}

export function legalConfig(env: NodeJS.ProcessEnv = process.env): LegalConfig {
  const privacyEmail = env.VATRA_PRIVACY_EMAIL || "privacy@dragoscatalin.ro";
  const securityEmail = env.VATRA_SECURITY_EMAIL || "security@dragoscatalin.ro";
  const postal = env.VATRA_PUBLISHER_POSTAL || PLACEHOLDER_POSTAL;
  const phone = env.VATRA_PUBLISHER_PHONE || PLACEHOLDER_POSTAL;
  return {
    publisher: env.VATRA_PUBLISHER_NAME || "Dragos Catalin Vladulescu",
    country: "Romania",
    privacyEmail,
    securityEmail,
    postal,
    phone,
    sourceUrl: env.VATRA_SOURCE_URL || "https://github.com/dragoscatalin/vatra",
    version: env.VATRA_VERSION || null,
    commit: env.VATRA_COMMIT ? env.VATRA_COMMIT.slice(0, 12) : null,
    placeholders: !env.VATRA_PRIVACY_EMAIL || !env.VATRA_SECURITY_EMAIL || postal === PLACEHOLDER_POSTAL,
  };
}
