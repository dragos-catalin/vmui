#!/usr/bin/env node
// Seeds the throwaway e2e DB on the cloud VM: one admin user + one session. Writes the
// session id to /tmp/e2e-session (mode 600) for the Playwright specs (PW_SESSION_FILE).
// An infra admin without a home_members row is treated as the home owner, so no family row.
// Run AFTER the server has imported the db module once (it creates the schema).
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const Database = require("better-sqlite3");

const dbPath = process.env.VMUI_DB_PATH;
if (!dbPath) {
  console.error("seed: VMUI_DB_PATH is not set");
  process.exit(1);
}
const out = process.env.E2E_SESSION_OUT || "/tmp/e2e-session";
const db = new Database(dbPath);
db.pragma("busy_timeout = 10000");

const hasTable = (t) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t));
if (!hasTable("users") || !hasTable("sessions")) {
  console.error("seed: users/sessions tables missing — start the server and hit /api/health first");
  process.exit(1);
}

const email = ["e2e", "vmui.test"].join("@");
const now = Math.floor(Date.now() / 1000);
// Same format as src/lib/auth.ts hashPassword: scrypt$<salthex>$<keyhex>, 64-byte key.
const salt = crypto.randomBytes(16);
const key = crypto.scryptSync(crypto.randomBytes(18).toString("hex"), salt, 64);
const passwordHash = `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;

const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
const userId = existing ? existing.id : `e2e-${crypto.randomBytes(8).toString("hex")}`;
if (!existing) {
  db.prepare(
    "INSERT INTO users (id, email, display_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, 'admin', ?)",
  ).run(userId, email, "E2E Admin", passwordHash, now);
}

const sessionId = crypto.randomBytes(32).toString("hex");
// expires_at is epoch SECONDS (drizzle integer mode "timestamp").
db.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(
  sessionId,
  userId,
  now + 7 * 86400,
  now,
  now,
);
db.close();

fs.writeFileSync(out, sessionId, { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`seed: admin ${existing ? "reused" : "created"}, session written to ${out}`);
