/**
 * tools/kiro.ts — adapter for Kiro CLI's auth session.
 *
 * Kiro CLI (verified on 2.22.x) keeps its session in a SQLite database,
 * NOT in ~/.aws/sso/cache (that file layout is legacy and no longer read):
 *
 *   Linux: ~/.local/share/kiro-cli/data.sqlite3
 *   macOS: ~/Library/Application Support/kiro-cli/data.sqlite3
 *
 *   table auth_kv (key, value):
 *     kirocli:odic:token                — access/refresh token, expiry, region, start_url
 *     kirocli:odic:device-registration  — OAuth client registration
 *   table state (key, value):
 *     auth.idc.start-url, auth.idc.region, api.codewhisperer.profile
 *
 * A profile snapshot copies every auth_kv row plus the auth-related state
 * rows, so switching restores the full identity (incl. the CodeWhisperer
 * profile ARN). The account email is not stored in the DB; it is fetched
 * best-effort via `kiro-cli whoami --format json` and kept as non-secret
 * metadata so profiles can be told apart.
 *
 * There is no supported non-interactive login for Kiro, so this adapter
 * exposes `manualLoginHint` instead of `login`/`logout`.
 */

import { existsSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";
import { createRequire } from "module";
import { spawnSync } from "child_process";
import { AuthstashError, type AuthSnapshot, type AuthSummary, type ToolAdapter } from "../core.js";

const SNAPSHOT_FORMAT = "kiro-cli-sqlite/1";

function defaultDbPath(): string {
  const base = platform() === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "kiro-cli", "data.sqlite3");
}

const KIRO_DB_PATH = process.env.AUTHSTASH_KIRO_DB || defaultDbPath();
const KIRO_STATE_DIR = process.env.AUTHSTASH_KIRO_STATE_DIR || join(homedir(), ".kiro");

/** `state` rows that belong to the signed-in identity. */
function isAuthStateKey(key: string): boolean {
  return key.startsWith("auth.") || key === "api.codewhisperer.profile";
}

interface KiroSnapshot extends AuthSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  auth_kv: Record<string, string>;
  state: Record<string, string>;
  email?: string;
}

/** Profiles saved by authstash ≤1.0.0 from ~/.aws/sso/cache. */
function isLegacy(snap: AuthSnapshot | null | undefined): boolean {
  return !!snap && snap.format !== SNAPSHOT_FORMAT && "token" in snap;
}

// ── sqlite access (node:sqlite, Node ≥22.13) ──────────────────────

interface Stmt { all(...p: unknown[]): any[]; run(...p: unknown[]): unknown }
interface Db { prepare(sql: string): Stmt; exec(sql: string): void; close(): void }

function openDb(readOnly: boolean): Db {
  let mod: { DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => Db };
  try {
    // Suppress node:sqlite's ExperimentalWarning so it doesn't pollute output.
    const emit = process.emitWarning;
    process.emitWarning = (() => {}) as typeof process.emitWarning;
    try {
      mod = createRequire(import.meta.url)("node:sqlite");
    } finally {
      process.emitWarning = emit;
    }
  } catch {
    throw new AuthstashError(
      `Kiro support needs Node.js ≥22.13 (built-in node:sqlite); current: ${process.version}`,
    );
  }
  return new mod.DatabaseSync(KIRO_DB_PATH, { readOnly });
}

function parseJson(v: string | undefined): any {
  if (!v) return undefined;
  try { return JSON.parse(v); } catch { return undefined; }
}

/** Best-effort account email; never throws. */
function fetchEmail(): string | undefined {
  if (process.env.AUTHSTASH_KIRO_NO_WHOAMI) return undefined;
  const r = spawnSync("kiro-cli", ["whoami", "--format", "json"], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0 || !r.stdout) return undefined;
  const firstLine = r.stdout.split("\n").find((l) => l.trim().startsWith("{"));
  const email = parseJson(firstLine)?.email;
  return typeof email === "string" ? email : undefined;
}

// ── adapter ───────────────────────────────────────────────────────

export const kiroTool: ToolAdapter = {
  id: "kiro",
  displayName: "Kiro CLI",
  stateDir: KIRO_STATE_DIR,

  readLive(): AuthSnapshot | null {
    if (!existsSync(KIRO_DB_PATH)) return null;
    const db = openDb(true);
    try {
      const auth_kv: Record<string, string> = {};
      for (const r of db.prepare("SELECT key, value FROM auth_kv").all()) auth_kv[r.key] = r.value;
      if (Object.keys(auth_kv).length === 0) return null;
      const state: Record<string, string> = {};
      for (const r of db.prepare("SELECT key, value FROM state").all()) {
        if (isAuthStateKey(r.key)) state[r.key] = r.value;
      }
      const snap: KiroSnapshot = { format: SNAPSHOT_FORMAT, auth_kv, state };
      const email = fetchEmail();
      if (email) snap.email = email;
      return snap;
    } finally {
      db.close();
    }
  },

  writeLive(snapshot: AuthSnapshot): void {
    if (isLegacy(snapshot)) {
      throw new AuthstashError(
        "this profile was saved in the legacy ~/.aws/sso/cache format, which Kiro CLI no longer reads.\n" +
        "  Sign in to that account in Kiro CLI, then re-save it: authstash kiro save <name>",
      );
    }
    const snap = snapshot as KiroSnapshot;
    if (snap.format !== SNAPSHOT_FORMAT || !snap.auth_kv) {
      throw new AuthstashError("profile is not a valid Kiro snapshot — cannot activate");
    }
    if (!existsSync(KIRO_DB_PATH)) {
      throw new AuthstashError(`Kiro CLI database not found at ${KIRO_DB_PATH} — run kiro-cli once first`);
    }
    const db = openDb(false);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM auth_kv").run();
        const insAuth = db.prepare("INSERT INTO auth_kv (key, value) VALUES (?, ?)");
        for (const [k, v] of Object.entries(snap.auth_kv)) insAuth.run(k, v);

        const delState = db.prepare("DELETE FROM state WHERE key = ?");
        for (const r of db.prepare("SELECT key FROM state").all()) {
          if (isAuthStateKey(r.key)) delState.run(r.key);
        }
        const insState = db.prepare("INSERT INTO state (key, value) VALUES (?, ?)");
        for (const [k, v] of Object.entries(snap.state ?? {})) insState.run(k, v);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      db.close();
    }
  },

  summarize(snapshot: AuthSnapshot | null): AuthSummary {
    if (!snapshot) return { present: false };
    if (isLegacy(snapshot)) {
      const t = (snapshot as any).token ?? {};
      return {
        present: true,
        label: `legacy ${t.provider ?? "Kiro"}${t.region ? ` (${t.region})` : ""} — re-save needed`,
        legacy: true,
        expires_at: t.expiresAt,
      };
    }
    const snap = snapshot as KiroSnapshot;
    const tok = parseJson(snap.auth_kv?.["kirocli:odic:token"]) ?? {};
    const prof = parseJson(snap.state?.["api.codewhisperer.profile"]);
    const startUrl: string | undefined = tok.start_url;
    let host: string | undefined;
    try { host = startUrl ? new URL(startUrl).host : undefined; } catch { /* ignore */ }

    let expired: boolean | undefined;
    let expires_in_s: number | null = null;
    if (tok.expires_at) {
      const exp = Date.parse(tok.expires_at);
      if (!Number.isNaN(exp)) {
        expires_in_s = Math.floor((exp - Date.now()) / 1000);
        expired = expires_in_s <= 0;
      }
    }
    return {
      present: true,
      label: snap.email ?? (host ? `${host}${tok.region ? ` (${tok.region})` : ""}` : "Kiro session"),
      email: snap.email,
      start_url: startUrl,
      region: tok.region,
      profile_name: prof?.profile_name,
      // Access token is short-lived; Kiro refreshes it with the refresh token.
      expires_at: tok.expires_at,
      expired,
      expires_in_s,
      has_refresh_token: !!tok.refresh_token,
    };
  },

  defaultName(snapshot: AuthSnapshot): string {
    const snap = snapshot as KiroSnapshot;
    const base = snap.email?.split("@")[0] ?? parseJson(snap.auth_kv?.["kirocli:odic:token"])?.region ?? "default";
    return String(base).replace(/[^a-zA-Z0-9._+-]/g, "-");
  },

  sameAccount(live: AuthSnapshot, stored: AuthSnapshot): boolean {
    if (isLegacy(stored) || isLegacy(live)) return false;
    const a = (live as KiroSnapshot).email;
    const b = (stored as KiroSnapshot).email;
    // Without both emails we can't tell; fall back to start URL + region.
    if (a && b) return a.toLowerCase() === b.toLowerCase();
    const ta = parseJson((live as KiroSnapshot).auth_kv?.["kirocli:odic:token"]) ?? {};
    const tb = parseJson((stored as KiroSnapshot).auth_kv?.["kirocli:odic:token"]) ?? {};
    const same = ta.start_url === tb.start_url && ta.region === tb.region;
    // whoami was unavailable: keep the known email so write-back doesn't drop it.
    if (same && !a && b) (live as KiroSnapshot).email = b;
    return same;
  },

  manualLoginHint:
    "Kiro's sign-in is browser-based and cannot be automated.\n" +
    "  1. kiro-cli logout && kiro-cli login   (sign in as the new account)\n" +
    "  2. Run: authstash kiro save <name>",

  warnings(): string[] {
    return [];
  },
};

export { KIRO_DB_PATH };
