/**
 * tools/kiro.ts — adapter for Kiro CLI's AWS SSO/OAuth session.
 *
 * Kiro does NOT store its session under ~/.kiro. It authenticates via
 * AWS SSO/OAuth and caches the session under ~/.aws/sso/cache/:
 *
 *   ~/.aws/sso/cache/kiro-auth-token.json   — accessToken, refreshToken,
 *                                              expiresAt, clientIdHash,
 *                                              authMethod, provider, region
 *   ~/.aws/sso/cache/<clientIdHash>.json    — OAuth client registration
 *                                              (clientId, clientSecret, expiresAt)
 *
 * A profile snapshot bundles both files together (the token references
 * its client registration by clientIdHash, so both must travel as a pair).
 *
 * There is no supported non-interactive login/logout for Kiro, so this
 * adapter does not implement `login`/`logout`. Users authenticate via
 * the normal Kiro CLI sign-in flow, then run `authstash kiro save <name>`.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, chmodSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AuthSnapshot, AuthSummary, ToolAdapter } from "../core.js";

const AWS_SSO_CACHE_DIR = process.env.AUTHSTASH_KIRO_SSO_CACHE_DIR || join(homedir(), ".aws", "sso", "cache");
const TOKEN_PATH = join(AWS_SSO_CACHE_DIR, "kiro-auth-token.json");
// authstash keeps its own profile store under ~/.kiro/accounts (config-only
// directory; no secrets live there outside of what authstash itself writes).
const KIRO_STATE_DIR = process.env.AUTHSTASH_KIRO_STATE_DIR || join(homedir(), ".kiro");

interface KiroTokenFile {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  clientIdHash?: string;
  authMethod?: string;
  provider?: string;
  region?: string;
  [k: string]: unknown;
}

interface KiroClientRegistration {
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  [k: string]: unknown;
}

/** Bundled snapshot: the token plus its paired client registration. */
interface KiroSnapshot extends AuthSnapshot {
  token: KiroTokenFile;
  clientRegistration: KiroClientRegistration | null;
  clientIdHash: string | null;
}

function clientRegistrationPath(clientIdHash: string): string {
  return join(AWS_SSO_CACHE_DIR, `${clientIdHash}.json`);
}

function readToken(): KiroTokenFile | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as KiroTokenFile;
  } catch (e) {
    throw new Error(`cannot parse ${TOKEN_PATH}: ${e}`);
  }
}

function readClientRegistration(clientIdHash: string | undefined | null): KiroClientRegistration | null {
  if (!clientIdHash) return null;
  const p = clientRegistrationPath(clientIdHash);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as KiroClientRegistration;
  } catch {
    return null;
  }
}

function writeJsonSecret(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  // rename is atomic on the same filesystem
  try {
    unlinkSync(path);
  } catch { /* file may not exist yet */ }
  writeFileSync(path, readFileSync(tmp));
  unlinkSync(tmp);
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
}

export const kiroTool: ToolAdapter = {
  id: "kiro",
  displayName: "Kiro CLI",
  stateDir: KIRO_STATE_DIR,

  readLive(): AuthSnapshot | null {
    const token = readToken();
    if (!token) return null;
    const clientRegistration = readClientRegistration(token.clientIdHash);
    const snap: KiroSnapshot = {
      token,
      clientRegistration,
      clientIdHash: token.clientIdHash ?? null,
    };
    return snap;
  },

  writeLive(snapshot: AuthSnapshot): void {
    const snap = snapshot as KiroSnapshot;
    if (!snap.token) throw new Error("profile is missing a Kiro token — cannot activate");
    writeJsonSecret(TOKEN_PATH, snap.token);
    if (snap.clientRegistration && snap.clientIdHash) {
      writeJsonSecret(clientRegistrationPath(snap.clientIdHash), snap.clientRegistration);
    }
  },

  summarize(snapshot: AuthSnapshot | null): AuthSummary {
    const snap = snapshot as KiroSnapshot | null;
    if (!snap || !snap.token) return { present: false };
    const t = snap.token;
    let expired: boolean | undefined;
    let expires_in_s: number | null = null;
    if (t.expiresAt) {
      const exp = Date.parse(t.expiresAt);
      if (!Number.isNaN(exp)) {
        expires_in_s = Math.floor((exp - Date.now()) / 1000);
        expired = expires_in_s <= 0;
      }
    }
    return {
      present: true,
      label: t.provider ? `${t.provider}${t.region ? ` (${t.region})` : ""}` : t.authMethod,
      auth_method: t.authMethod,
      provider: t.provider,
      region: t.region,
      expires_at: t.expiresAt,
      expired,
      expires_in_s,
    };
  },

  defaultName(snapshot: AuthSnapshot): string {
    const snap = snapshot as KiroSnapshot;
    const t = snap.token;
    if (t?.provider) return t.provider.replace(/[^a-zA-Z0-9._+-]/g, "-");
    if (t?.region) return t.region.replace(/[^a-zA-Z0-9._+-]/g, "-");
    return "default";
  },

  // No automated login/logout: Kiro's OAuth/SSO sign-in is interactive and
  // browser-driven. `authstash kiro add <name>` will instruct the user to
  // sign in manually, then snapshot the result.
  manualLoginHint:
    "Kiro's sign-in is browser-based and cannot be automated.\n" +
    "  1. Sign out / switch accounts in Kiro CLI's own login flow.\n" +
    "  2. Complete sign-in for the new account.\n" +
    "  3. Run: authstash kiro save <name>",

  warnings(): string[] {
    return [];
  },
};

export { TOKEN_PATH as KIRO_TOKEN_PATH, AWS_SSO_CACHE_DIR as KIRO_SSO_CACHE_DIR };

/** Discover orphaned/legacy client-registration cache files (diagnostics only). */
export function listSsoClientRegistrations(): string[] {
  if (!existsSync(AWS_SSO_CACHE_DIR)) return [];
  return readdirSync(AWS_SSO_CACHE_DIR).filter((f) => f.endsWith(".json") && f !== "kiro-auth-token.json");
}
