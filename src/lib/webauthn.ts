import "server-only";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { headers } from "next/headers";

/**
 * Local-first WebAuthn config. RP id must equal the hostname users hit in
 * the browser. vmui binds 127.0.0.1:3737 so "127.0.0.1" is the default; if
 * users tunnel through another hostname they need to set VMUI_WEBAUTHN_RP.
 */
// Display name shown by the OS passkey sheet; the RP id (hostname) is what binds credentials.
const RP_NAME = "Vatra";

async function rpConfig(): Promise<{ rpID: string; origin: string }> {
  const hdr = await headers();
  const host = hdr.get("host") ?? "127.0.0.1:3737";
  const hostname = host.split(":")[0] ?? "127.0.0.1";
  const proto = hdr.get("x-forwarded-proto") ?? "http";
  return {
    rpID: process.env.VMUI_WEBAUTHN_RP ?? hostname,
    origin: `${proto}://${host}`,
  };
}

interface PendingChallenge {
  challenge: string;
  expiresAt: number;
  /** Bound to a userId on registration, or undefined for authentication. */
  userId?: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __vmuiWebauthnChallenges__: Map<string, PendingChallenge> | undefined;
}

function challengeStore(): Map<string, PendingChallenge> {
  if (!globalThis.__vmuiWebauthnChallenges__) {
    globalThis.__vmuiWebauthnChallenges__ = new Map();
  }
  return globalThis.__vmuiWebauthnChallenges__;
}

const CHALLENGE_TTL_MS = 5 * 60_000;

function gc(): void {
  const now = Date.now();
  const store = challengeStore();
  for (const [k, v] of store) {
    if (v.expiresAt < now) store.delete(k);
  }
}

export function rememberChallenge(key: string, challenge: string, userId?: string): void {
  gc();
  challengeStore().set(key, { challenge, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

export function consumeChallenge(key: string): PendingChallenge | null {
  gc();
  const store = challengeStore();
  const v = store.get(key);
  if (!v) return null;
  store.delete(key);
  if (v.expiresAt < Date.now()) return null;
  return v;
}

export async function buildRegistrationOptions(input: {
  userId: string;
  email: string;
  displayName: string;
  excludeCredentialIds: string[];
}) {
  const { rpID } = await rpConfig();
  const opts = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: new TextEncoder().encode(input.userId),
    userName: input.email,
    userDisplayName: input.displayName,
    attestationType: "none",
    excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  return opts;
}

export async function verifyRegistration(input: {
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}) {
  const { rpID, origin } = await rpConfig();
  return verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
}

export async function buildAuthenticationOptions(input: {
  allowCredentialIds: string[];
}) {
  const { rpID } = await rpConfig();
  return generateAuthenticationOptions({
    rpID,
    allowCredentials: input.allowCredentialIds.map((id) => ({ id })),
    userVerification: "preferred",
  });
}

export async function verifyAuthentication(input: {
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
}) {
  const { rpID, origin } = await rpConfig();
  return verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: input.expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: input.credentialId,
      publicKey: Uint8Array.from(Buffer.from(input.publicKey, "base64url")),
      counter: input.counter,
      transports: input.transports,
    },
  });
}

export type { RegistrationResponseJSON, AuthenticationResponseJSON };
