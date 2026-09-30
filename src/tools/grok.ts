/**
 * tools/grok.ts — adapter for Grok CLI's ~/.grok/auth.json OIDC session.
 *
 * Preserves the exact on-disk layout of the original standalone
 * grok-auth tool (~/.grok/accounts/...) for backward compatibility.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, copyFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";
import type { AuthSnapshot, AuthSummary, ToolAdapter } from "../core.js";

const GROK_DIR = process.env.GROK_DIR || join(homedir(), ".grok");
const AUTH_PATH = join(GROK_DIR, "auth.json");

interface GrokAuthEntry {
  key?: string;
  auth_mode?: string;
  user_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  principal_id?: string;
  team_id?: string;
  refresh_token?: string;
  expires_at?: string;
  [k: string]: unknown;
}

type GrokAuthFile = Record<string, GrokAuthEntry>;

function primaryEntry(auth: GrokAuthFile): { key: string; entry: GrokAuthEntry } | null {
  const keys = Object.keys(auth);
  if (keys.length === 0) return null;
  const preferred = keys.find((k) => k.includes("auth.x.ai") || k.includes("accounts.x.ai")) ?? keys[0]!;
  return { key: preferred, entry: auth[preferred]! };
}

function readAuth(): GrokAuthFile | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as GrokAuthFile;
  } catch (e) {
    throw new Error(`cannot parse ${AUTH_PATH}: ${e}`);
  }
}

function writeAuth(auth: GrokAuthFile): void {
  const tmp = AUTH_PATH + `.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  renameSync(tmp, AUTH_PATH);
  try { chmodSync(AUTH_PATH, 0o600); } catch { /* ignore */ }
}

export const grokTool: ToolAdapter = {
  id: "grok",
  displayName: "Grok CLI",
  stateDir: GROK_DIR,

  readLive(): AuthSnapshot | null {
    return readAuth();
  },

  writeLive(snapshot: AuthSnapshot): void {
    writeAuth(snapshot as GrokAuthFile);
  },

  summarize(snapshot: AuthSnapshot | null): AuthSummary {
    const auth = snapshot as GrokAuthFile | null;
    if (!auth) return { present: false };
    const pe = primaryEntry(auth);
    if (!pe) return { present: false };
    const e = pe.entry;
    let expired: boolean | undefined;
    let expires_in_s: number | null = null;
    if (e.expires_at) {
      const exp = Date.parse(e.expires_at);
      if (!Number.isNaN(exp)) {
        expires_in_s = Math.floor((exp - Date.now()) / 1000);
        expired = expires_in_s <= 0;
      }
    }
    return {
      present: true,
      label: e.email ?? e.user_id,
      email: e.email,
      user_id: e.user_id,
      principal_id: e.principal_id,
      team_id: e.team_id,
      first_name: e.first_name,
      last_name: e.last_name,
      auth_mode: e.auth_mode,
      expires_at: e.expires_at,
      expired,
      expires_in_s,
    };
  },

  defaultName(snapshot: AuthSnapshot): string {
    const s = this.summarize(snapshot);
    if (s.email && typeof s.email === "string") {
      const local = s.email.split("@")[0]!.replace(/[^a-zA-Z0-9._+-]/g, "-");
      return local || "default";
    }
    if (s.user_id && typeof s.user_id === "string") return s.user_id.slice(0, 8);
    return "default";
  },

  login(): { ok: boolean; message?: string } {
    const login = spawnSync("grok", ["login"], { stdio: "inherit", env: process.env });
    if (login.status !== 0) {
      return { ok: false, message: `grok login failed (exit ${login.status ?? "spawn error"})` };
    }
    return { ok: true };
  },

  logout(): { ok: boolean; message?: string } {
    const logout = spawnSync("grok", ["logout"], { stdio: "inherit", env: process.env });
    if (logout.error) {
      if (existsSync(AUTH_PATH)) {
        const bak = AUTH_PATH + ".bak-before-add";
        copyFileSync(AUTH_PATH, bak);
        unlinkSync(AUTH_PATH);
      }
      return { ok: true, message: "grok CLI not found on PATH — backed up and cleared auth.json manually" };
    }
    return { ok: true };
  },

  warnings(): string[] {
    const w: string[] = [];
    if (process.env.XAI_API_KEY) {
      w.push("warning: XAI_API_KEY is set — API key may take precedence over auth.json depending on grok version. Unset it if you want OIDC account switching.");
    }
    return w;
  },
};

export { AUTH_PATH as GROK_AUTH_PATH };
