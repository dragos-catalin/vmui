import type { useTranslations } from "next-intl";

type AuthT = ReturnType<typeof useTranslations<"auth">>;

const EXACT: Record<string, Parameters<AuthT>[0]> = {
  "Enter a valid email and password": "errors.invalidInput",
  "Invalid email or password": "errors.invalidCredentials",
  "Enter the 6-digit code": "errors.codeInvalidInput",
  "Verification expired. Sign in again.": "errors.verificationExpired",
  "User not found": "errors.userNotFound",
  "2FA not enrolled": "errors.notEnrolled",
  "Could not decrypt 2FA secret": "errors.decryptFailed",
  "Invalid code.": "errors.invalidCode",
  "Failed to create user": "errors.createFailed",
  "Not authenticated": "errors.notAuthenticated",
  "No passkeys registered yet": "errors.noPasskeys",
  "Challenge expired": "errors.challengeExpired",
  "Challenge expired or invalid": "errors.challengeExpired",
  "Unknown passkey": "errors.unknownPasskey",
  "Verification failed": "errors.verificationFailed",
  invalid: "errors.inviteInvalid",
  email_taken: "errors.emailTaken",
  "Invalid input": "errors.invalidInput",
  setup_code_wrong: "errors.setupCodeWrong",
  setup_code_locked: "errors.setupCodeLocked",
};

/** Server actions return English literals; translate the known ones, fall back to a generic wrapper. */
export function translateAuthError(t: AuthT, raw: string | undefined | null): string | null {
  if (!raw) return null;
  const exact = EXACT[raw];
  if (exact) return t(exact);
  const rl = /^Too many attempts\. Try again in (\d+)s\.$/.exec(raw);
  if (rl) return t("errors.rateLimited", { seconds: Number(rl[1]) });
  if (/^Role '\w+' required/.test(raw)) return t("errors.adminRequired");
  if (/UNIQUE constraint failed: users\.email/i.test(raw)) return t("errors.emailTaken");
  const parts = raw.split("; ").map((p) => zodIssue(t, p)).filter((p): p is string => p !== null);
  if (parts.length > 0) return parts.join(" ");
  return t("errors.generic", { message: raw });
}

function zodIssue(t: AuthT, msg: string): string | null {
  if (/invalid email/i.test(msg)) return t("errors.invalidEmail");
  if (/>=8 characters/.test(msg)) return t("errors.passwordShort");
  if (/>=1 characters/.test(msg)) return t("errors.nameRequired");
  return null;
}
