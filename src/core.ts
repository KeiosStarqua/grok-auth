/**
 * core.ts — generic multi-profile auth-switcher engine.
 *
 * A "tool adapter" (see tools/*.ts) tells this engine:
 *   - where the tool's live auth file(s) live
 *   - how to read/write/summarize them
 *   - (optionally) how to trigger a fresh login
 *
 * This module implements the account-rotation mechanics once:
 * save / use / next / remove / rename / sync / list / current.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, chmodSync } from "fs";
import { join } from "path";

// ── generic types ─────────────────────────────────────────────────

/** Arbitrary JSON-serializable snapshot of a tool's live auth state. */
export type AuthSnapshot = Record<string, unknown>;

/** Human-friendly summary of an auth snapshot, tool-specific fields allowed. */
export interface AuthSummary {
  present: boolean;
  label?: string; // primary human identifier (email, username, etc.)
  expires_at?: string;
  expired?: boolean;
  expires_in_s?: number | null;
  [k: string]: unknown;
}

export interface ProfileMeta {
  label?: string;
  expires_at?: string;
  saved_at: string;
  updated_at: string;
  [k: string]: unknown;
}

export interface Meta {
  version: 1;
  active: string | null;
  profiles: Record<string, ProfileMeta>;
}

/**
 * A ToolAdapter encapsulates everything tool-specific: where its auth
 * lives on disk, how to read/write it, and how to summarize/name profiles.
 */
export interface ToolAdapter {
  /** Short id used in paths/help, e.g. "grok", "kiro". */
  id: string;
  /** Human display name, e.g. "Grok CLI", "Kiro CLI". */
  displayName: string;
  /** Directory under which this tool's `accounts/` profile store lives. */
  stateDir: string;
  /** Read the tool's current live auth snapshot, or null if absent. */
  readLive(): AuthSnapshot | null;
  /** Atomically write a snapshot back as the tool's live auth state. */
  writeLive(snapshot: AuthSnapshot): void;
  /** Summarize a snapshot for humans/JSON output. */
  summarize(snapshot: AuthSnapshot | null): AuthSummary;
  /** Suggest a profile name when the user doesn't give one. */
  defaultName(snapshot: AuthSnapshot): string;
  /** Optional: run an interactive login/logout flow (used by `add`). */
  login?(): { ok: boolean; message?: string };
  logout?(): { ok: boolean; message?: string };
  /**
   * Optional: shown by `add` when no automated `login()` is available,
   * e.g. tools with browser-only OAuth flows this CLI cannot drive.
   */
  manualLoginHint?: string;
  /** Optional: extra warnings to print (e.g. env var overrides). */
  warnings?(): string[];
}

// ── path helpers ───────────────────────────────────────────────────

export function accountsDir(t: ToolAdapter): string {
  return join(t.stateDir, "accounts");
}
export function profilesDir(t: ToolAdapter): string {
  return join(accountsDir(t), "profiles");
}
export function metaPath(t: ToolAdapter): string {
  return join(accountsDir(t), "meta.json");
}

export function ensureDirs(t: ToolAdapter): void {
  for (const d of [accountsDir(t), profilesDir(t)]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

export function profilePath(t: ToolAdapter, name: string): string {
  if (!/^[a-zA-Z0-9._@+-]+$/.test(name)) {
    throw new AuthstashError(`invalid profile name '${name}' (use letters, numbers, . _ @ + -)`);
  }
  return join(profilesDir(t), `${name}.json`);
}

/** Error type carrying an intended process exit code. */
export class AuthstashError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

// ── meta persistence ────────────────────────────────────────────────

export function loadMeta(t: ToolAdapter): Meta {
  ensureDirs(t);
  const p = metaPath(t);
  if (!existsSync(p)) return { version: 1, active: null, profiles: {} };
  try {
    const m = JSON.parse(readFileSync(p, "utf8")) as Meta;
    if (!m.profiles) m.profiles = {};
    return m;
  } catch {
    return { version: 1, active: null, profiles: {} };
  }
}

export function saveMeta(t: ToolAdapter, meta: Meta): void {
  ensureDirs(t);
  const p = metaPath(t);
  writeFileSync(p, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* ignore */ }
}

// ── snapshot persistence ──────────────────────────────────────────

export function metaFromSnapshot(t: ToolAdapter, snap: AuthSnapshot, prev?: ProfileMeta): ProfileMeta {
  const s = t.summarize(snap);
  const now = new Date().toISOString();
  return {
    label: s.label,
    expires_at: s.expires_at,
    saved_at: prev?.saved_at ?? now,
    updated_at: now,
  };
}

export function formatExpiry(expires_at?: string): string {
  if (!expires_at) return "unknown";
  const exp = Date.parse(expires_at);
  if (Number.isNaN(exp)) return expires_at;
  const sec = Math.floor((exp - Date.now()) / 1000);
  if (sec <= 0) return `EXPIRED (${expires_at})`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h >= 48) return `in ${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return `in ${m}m`;
}

/** Persist current live auth into the named profile (or active). */
export function syncToProfile(t: ToolAdapter, name: string, snap?: AuthSnapshot | null): AuthSnapshot {
  const a = snap ?? t.readLive();
  if (!a) throw new AuthstashError(`no live auth for ${t.displayName} — log in first`);
  ensureDirs(t);
  const path = profilePath(t, name);
  writeFileSync(path, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
  const meta = loadMeta(t);
  meta.profiles[name] = metaFromSnapshot(t, a, meta.profiles[name]);
  if (!meta.active) meta.active = name;
  saveMeta(t, meta);
  return a;
}

/** Before leaving an account, write the live session back into its profile. */
export function syncActiveIfAny(t: ToolAdapter): void {
  const meta = loadMeta(t);
  if (!meta.active) return;
  const snap = t.readLive();
  if (!snap) return;
  if (!meta.profiles[meta.active] && !existsSync(profilePath(t, meta.active))) return;
  syncToProfile(t, meta.active, snap);
}

// ── commands (tool-agnostic) ───────────────────────────────────────

export interface ListRow {
  name: string;
  active: boolean;
  label?: string;
  expires: string;
  expires_at?: string;
  updated_at: string;
}

export function listProfiles(t: ToolAdapter): { active: string | null; live: AuthSummary; rows: ListRow[] } {
  const meta = loadMeta(t);
  ensureDirs(t);
  for (const f of readdirSync(profilesDir(t))) {
    if (!f.endsWith(".json")) continue;
    const n = f.slice(0, -5);
    if (!meta.profiles[n]) {
      try {
        const snap = JSON.parse(readFileSync(join(profilesDir(t), f), "utf8")) as AuthSnapshot;
        meta.profiles[n] = metaFromSnapshot(t, snap);
      } catch { /* skip unreadable profile files */ }
    }
  }
  const live = t.summarize(t.readLive());
  const rows: ListRow[] = Object.entries(meta.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]) => ({
      name,
      active: meta.active === name,
      label: p.label,
      expires: formatExpiry(p.expires_at),
      expires_at: p.expires_at,
      updated_at: p.updated_at,
    }));
  return { active: meta.active, live, rows };
}

export function currentProfile(t: ToolAdapter): { active: string | null; live: AuthSummary; profile: ProfileMeta | null } {
  const meta = loadMeta(t);
  const live = t.summarize(t.readLive());
  return { active: meta.active, live, profile: meta.active ? meta.profiles[meta.active] ?? null : null };
}

export function saveProfile(t: ToolAdapter, nameArg?: string): { name: string; summary: AuthSummary } {
  const snap = t.readLive();
  if (!snap) throw new AuthstashError(`no live auth for ${t.displayName} — log in first`);
  const name = nameArg || t.defaultName(snap);
  syncToProfile(t, name, snap);
  const m = loadMeta(t);
  m.active = name;
  saveMeta(t, m);
  return { name, summary: t.summarize(snap) };
}

export function useProfile(t: ToolAdapter, name?: string): { name: string; summary: AuthSummary } {
  if (!name) throw new AuthstashError(`usage: use <name>`);
  const path = profilePath(t, name);
  if (!existsSync(path)) throw new AuthstashError(`profile '${name}' not found. run: list`);

  syncActiveIfAny(t);

  const snap = JSON.parse(readFileSync(path, "utf8")) as AuthSnapshot;
  t.writeLive(snap);

  const meta = loadMeta(t);
  meta.active = name;
  meta.profiles[name] = metaFromSnapshot(t, snap, meta.profiles[name]);
  saveMeta(t, meta);

  return { name, summary: t.summarize(snap) };
}

export function nextProfile(t: ToolAdapter): { name: string; summary?: AuthSummary; onlyOne?: boolean } {
  const meta = loadMeta(t);
  const names = Object.keys(meta.profiles).sort();
  if (names.length === 0) throw new AuthstashError(`no saved profiles. run: save [name]`);
  if (names.length === 1) {
    return { name: names[0]!, onlyOne: true };
  }
  const cur = meta.active;
  const idx = cur ? names.indexOf(cur) : -1;
  const next = names[(idx + 1) % names.length]!;
  const res = useProfile(t, next);
  return { name: res.name, summary: res.summary };
}

export function removeProfile(t: ToolAdapter, name?: string): { removed: string; wasActive: boolean } {
  if (!name) throw new AuthstashError(`usage: remove <name>`);
  const path = profilePath(t, name);
  const meta = loadMeta(t);
  if (!existsSync(path) && !meta.profiles[name]) throw new AuthstashError(`profile '${name}' not found`);
  if (existsSync(path)) unlinkSync(path);
  delete meta.profiles[name];
  const wasActive = meta.active === name;
  if (wasActive) meta.active = null;
  saveMeta(t, meta);
  return { removed: name, wasActive };
}

export function renameProfile(t: ToolAdapter, oldName?: string, newName?: string): { from: string; to: string } {
  if (!oldName || !newName) throw new AuthstashError(`usage: rename <old> <new>`);
  const from = profilePath(t, oldName);
  const to = profilePath(t, newName);
  if (!existsSync(from)) throw new AuthstashError(`profile '${oldName}' not found`);
  if (existsSync(to)) throw new AuthstashError(`profile '${newName}' already exists`);
  renameSync(from, to);
  const meta = loadMeta(t);
  meta.profiles[newName] = meta.profiles[oldName] ?? metaFromSnapshot(t, JSON.parse(readFileSync(to, "utf8")));
  delete meta.profiles[oldName];
  if (meta.active === oldName) meta.active = newName;
  saveMeta(t, meta);
  return { from: oldName, to: newName };
}

export function syncProfile(t: ToolAdapter): { name: string; summary: AuthSummary } {
  const meta = loadMeta(t);
  if (!meta.active) {
    const snap = t.readLive();
    if (!snap) throw new AuthstashError(`no live auth and no active profile`);
    const name = t.defaultName(snap);
    syncToProfile(t, name, snap);
    const m = loadMeta(t);
    m.active = name;
    saveMeta(t, m);
    return { name, summary: t.summarize(snap) };
  }
  const snap = syncToProfile(t, meta.active);
  return { name: meta.active, summary: t.summarize(snap) };
}

export function addProfile(t: ToolAdapter, name?: string): { name: string; summary: AuthSummary; requiresManualLogin?: boolean } {
  if (!name) throw new AuthstashError(`usage: add <name>`);
  profilePath(t, name); // validate name early

  syncActiveIfAny(t);

  if (!t.login) {
    // No automated login for this tool (e.g. browser-only OAuth). Surface
    // guidance and let the caller re-invoke `save` once they've signed in.
    const hint = t.manualLoginHint
      ?? `log in to ${t.displayName} manually, then run: save ${name}`;
    throw new AuthstashError(hint, 2);
  }

  if (t.logout) {
    const r = t.logout();
    if (r.message) console.error(r.message);
  }
  const r = t.login();
  if (!r.ok) {
    throw new AuthstashError(r.message ?? `${t.displayName} login failed`);
  }
  if (r.message) console.error(r.message);

  const snap = t.readLive();
  if (!snap) throw new AuthstashError("login finished but no live auth was found");
  syncToProfile(t, name, snap);
  const m = loadMeta(t);
  m.active = name;
  saveMeta(t, m);
  return { name, summary: t.summarize(snap) };
}
