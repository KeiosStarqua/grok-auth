#!/usr/bin/env bun
/**
 * grok-auth — switch between multiple Grok OIDC accounts
 *
 * Grok stores a single session in ~/.grok/auth.json.
 * This CLI snapshots that file into named profiles under
 * ~/.grok/accounts/ so you can rotate when token/usage runs out.
 *
 * Usage:
 *   grok-auth list
 *   grok-auth current
 *   grok-auth save [name]
 *   grok-auth use <name>
 *   grok-auth next
 *   grok-auth add <name>
 *   grok-auth remove <name>
 *   grok-auth rename <old> <new>
 *   grok-auth sync
 *   grok-auth whoami
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync, chmodSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { spawnSync } from "child_process";

// ── paths ──────────────────────────────────────────────────────────
const GROK_DIR = process.env.GROK_DIR || join(homedir(), ".grok");
const AUTH_PATH = join(GROK_DIR, "auth.json");
const ACCOUNTS_DIR = join(GROK_DIR, "accounts");
const PROFILES_DIR = join(ACCOUNTS_DIR, "profiles");
const META_PATH = join(ACCOUNTS_DIR, "meta.json");

// ── types ──────────────────────────────────────────────────────────
interface AuthEntry {
  key?: string;
  auth_mode?: string;
  create_time?: string;
  user_id?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  principal_type?: string;
  principal_id?: string;
  team_id?: string;
  refresh_token?: string;
  expires_at?: string;
  oidc_issuer?: string;
  oidc_client_id?: string;
  [k: string]: unknown;
}

type AuthFile = Record<string, AuthEntry>;

interface ProfileMeta {
  email?: string;
  user_id?: string;
  principal_id?: string;
  team_id?: string;
  first_name?: string;
  last_name?: string;
  auth_mode?: string;
  expires_at?: string;
  saved_at: string;
  updated_at: string;
}

interface Meta {
  version: 1;
  active: string | null;
  profiles: Record<string, ProfileMeta>;
}

// ── utils ──────────────────────────────────────────────────────────
const jsonOut = process.argv.includes("--json");

function die(msg: string, code = 1): never {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: msg }));
  } else {
    console.error(`error: ${msg}`);
  }
  process.exit(code);
}

function ok(data: unknown, human?: string) {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, ...((typeof data === "object" && data !== null) ? data as object : { data }) }));
  } else if (human) {
    console.log(human);
  } else if (data !== undefined) {
    console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
}

function ensureDirs() {
  for (const d of [ACCOUNTS_DIR, PROFILES_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

function loadMeta(): Meta {
  ensureDirs();
  if (!existsSync(META_PATH)) {
    return { version: 1, active: null, profiles: {} };
  }
  try {
    const m = JSON.parse(readFileSync(META_PATH, "utf8")) as Meta;
    if (!m.profiles) m.profiles = {};
    return m;
  } catch {
    return { version: 1, active: null, profiles: {} };
  }
}

function saveMeta(meta: Meta) {
  ensureDirs();
  writeFileSync(META_PATH, JSON.stringify(meta, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(META_PATH, 0o600); } catch { /* ignore */ }
}

function readAuth(): AuthFile | null {
  if (!existsSync(AUTH_PATH)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as AuthFile;
  } catch (e) {
    die(`cannot parse ${AUTH_PATH}: ${e}`);
  }
}

function writeAuth(auth: AuthFile) {
  // atomic-ish write
  const tmp = AUTH_PATH + `.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
  renameSync(tmp, AUTH_PATH);
  try { chmodSync(AUTH_PATH, 0o600); } catch { /* ignore */ }
}

function primaryEntry(auth: AuthFile): { key: string; entry: AuthEntry } | null {
  const keys = Object.keys(auth);
  if (keys.length === 0) return null;
  // Prefer OIDC-looking keys; otherwise first
  const preferred = keys.find((k) => k.includes("auth.x.ai") || k.includes("accounts.x.ai")) ?? keys[0];
  return { key: preferred, entry: auth[preferred] };
}

function summarizeAuth(auth: AuthFile | null): {
  present: boolean;
  email?: string;
  user_id?: string;
  principal_id?: string;
  team_id?: string;
  first_name?: string;
  last_name?: string;
  auth_mode?: string;
  expires_at?: string;
  expired?: boolean;
  expires_in_s?: number | null;
} {
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
}

function profilePath(name: string): string {
  // sanitize name to safe filename
  if (!/^[a-zA-Z0-9._@+-]+$/.test(name)) {
    die(`invalid profile name '${name}' (use letters, numbers, . _ @ + -)`);
  }
  return join(PROFILES_DIR, `${name}.json`);
}

function defaultNameFromAuth(auth: AuthFile): string {
  const s = summarizeAuth(auth);
  if (s.email) {
    const local = s.email.split("@")[0]!.replace(/[^a-zA-Z0-9._+-]/g, "-");
    return local || "default";
  }
  if (s.user_id) return s.user_id.slice(0, 8);
  return "default";
}

function metaFromAuth(auth: AuthFile, prev?: ProfileMeta): ProfileMeta {
  const s = summarizeAuth(auth);
  const now = new Date().toISOString();
  return {
    email: s.email,
    user_id: s.user_id,
    principal_id: s.principal_id,
    team_id: s.team_id,
    first_name: s.first_name,
    last_name: s.last_name,
    auth_mode: s.auth_mode,
    expires_at: s.expires_at,
    saved_at: prev?.saved_at ?? now,
    updated_at: now,
  };
}

function formatExpiry(expires_at?: string): string {
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

function warnApiKey() {
  if (process.env.XAI_API_KEY) {
    console.error("warning: XAI_API_KEY is set — API key may take precedence over auth.json depending on grok version. Unset it if you want OIDC account switching.");
  }
}

/** Persist current auth.json into the named profile (or active). */
function syncToProfile(name: string, auth?: AuthFile | null): AuthFile {
  const a = auth ?? readAuth();
  if (!a) die(`no auth.json at ${AUTH_PATH} — run: grok login`);
  ensureDirs();
  const path = profilePath(name);
  writeFileSync(path, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* ignore */ }
  const meta = loadMeta();
  meta.profiles[name] = metaFromAuth(a, meta.profiles[name]);
  if (!meta.active) meta.active = name;
  saveMeta(meta);
  return a;
}

/** Before leaving an account, write live auth.json back into its profile. */
function syncActiveIfAny() {
  const meta = loadMeta();
  if (!meta.active) return;
  if (!existsSync(AUTH_PATH)) return;
  const auth = readAuth();
  if (!auth) return;
  // Only sync if profile already exists (don't invent names)
  if (!meta.profiles[meta.active] && !existsSync(profilePath(meta.active))) return;
  syncToProfile(meta.active, auth);
}

// ── commands ───────────────────────────────────────────────────────
function cmdList() {
  const meta = loadMeta();
  const names = Object.keys(meta.profiles).sort();
  // also discover orphan profile files
  ensureDirs();
  for (const f of readdirSync(PROFILES_DIR)) {
    if (!f.endsWith(".json")) continue;
    const n = f.slice(0, -5);
    if (!meta.profiles[n]) {
      try {
        const auth = JSON.parse(readFileSync(join(PROFILES_DIR, f), "utf8")) as AuthFile;
        meta.profiles[n] = metaFromAuth(auth);
      } catch { /* skip */ }
    }
  }
  if (names.length === 0 && Object.keys(meta.profiles).length === 0) {
    ok({ profiles: [], active: meta.active }, "no saved accounts. run: grok-auth save [name]");
    return;
  }
  const live = summarizeAuth(readAuth());
  const rows = Object.entries(meta.profiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]) => ({
      name,
      active: meta.active === name,
      email: p.email,
      expires: formatExpiry(p.expires_at),
      expires_at: p.expires_at,
      updated_at: p.updated_at,
    }));

  if (jsonOut) {
    ok({ active: meta.active, live, profiles: rows });
    return;
  }
  console.log(`active: ${meta.active ?? "(none)"}`);
  if (live.present) {
    console.log(`live:   ${live.email ?? live.user_id ?? "?"}  expires ${formatExpiry(live.expires_at)}`);
  } else {
    console.log("live:   (no auth.json)");
  }
  console.log("");
  const w = Math.max(8, ...rows.map((r) => r.name.length));
  for (const r of rows) {
    const mark = r.active ? "*" : " ";
    console.log(`${mark} ${r.name.padEnd(w)}  ${(r.email ?? "-").padEnd(32)}  exp ${r.expires}`);
  }
  if (rows.length) console.log("\n* = active profile");
}

function cmdCurrent() {
  const meta = loadMeta();
  const live = summarizeAuth(readAuth());
  if (jsonOut) {
    ok({ active: meta.active, live, profile: meta.active ? meta.profiles[meta.active] : null });
    return;
  }
  if (!live.present) {
    console.log("no active grok session (missing auth.json)");
    console.log("run: grok login && grok-auth save <name>");
    return;
  }
  console.log(`profile:  ${meta.active ?? "(unsaved)"}`);
  console.log(`email:    ${live.email ?? "-"}`);
  console.log(`name:     ${[live.first_name, live.last_name].filter(Boolean).join(" ") || "-"}`);
  console.log(`user_id:  ${live.user_id ?? "-"}`);
  console.log(`team_id:  ${live.team_id ?? "-"}`);
  console.log(`mode:     ${live.auth_mode ?? "-"}`);
  console.log(`expires:  ${formatExpiry(live.expires_at)} (${live.expires_at ?? "-"})`);
  warnApiKey();
}

function cmdSave(nameArg?: string) {
  const auth = readAuth();
  if (!auth) die(`no auth.json at ${AUTH_PATH} — run: grok login first`);
  const name = nameArg || defaultNameFromAuth(auth);
  const meta = loadMeta();
  // if another profile is active, still overwrite target; also mark this as active
  syncToProfile(name, auth);
  meta.active = name;
  // re-load after syncToProfile mutated file
  const m = loadMeta();
  m.active = name;
  saveMeta(m);
  const s = summarizeAuth(auth);
  ok(
    { name, email: s.email, expires_at: s.expires_at },
    `saved profile '${name}' (${s.email ?? s.user_id ?? "?"}) and set active`
  );
}

function cmdUse(name?: string) {
  if (!name) die("usage: grok-auth use <name>");
  const path = profilePath(name);
  if (!existsSync(path)) die(`profile '${name}' not found. run: grok-auth list`);

  // Save current live session back into its profile so refresh tokens aren't lost
  syncActiveIfAny();

  const auth = JSON.parse(readFileSync(path, "utf8")) as AuthFile;
  writeAuth(auth);

  const meta = loadMeta();
  meta.active = name;
  meta.profiles[name] = metaFromAuth(auth, meta.profiles[name]);
  saveMeta(meta);

  const s = summarizeAuth(auth);
  warnApiKey();
  ok(
    { active: name, email: s.email, expires_at: s.expires_at },
    `switched to '${name}' (${s.email ?? s.user_id ?? "?"})\nnote: restart any running 'grok' sessions to pick up the new account`
  );
}

function cmdNext() {
  const meta = loadMeta();
  const names = Object.keys(meta.profiles).sort();
  if (names.length === 0) die("no saved profiles. run: grok-auth save [name]");
  if (names.length === 1) {
    ok({ active: names[0] }, `only one profile ('${names[0]}') — nothing to rotate`);
    return;
  }
  const cur = meta.active;
  let idx = cur ? names.indexOf(cur) : -1;
  const next = names[(idx + 1) % names.length]!;
  cmdUse(next);
}

function cmdAdd(name?: string) {
  if (!name) die("usage: grok-auth add <name>");
  profilePath(name); // validate

  // preserve current account first
  syncActiveIfAny();
  const meta = loadMeta();
  if (meta.active && existsSync(AUTH_PATH)) {
    console.error(`current profile '${meta.active}' saved. starting login for '${name}'...`);
  } else {
    console.error(`starting login for new profile '${name}'...`);
  }

  // Clear auth so grok login definitely prompts (logout if available)
  const logout = spawnSync("grok", ["logout"], { stdio: "inherit", env: process.env });
  if (logout.error) {
    // fallback: remove auth.json
    if (existsSync(AUTH_PATH)) {
      const bak = AUTH_PATH + ".bak-before-add";
      copyFileSync(AUTH_PATH, bak);
      unlinkSync(AUTH_PATH);
    }
  }

  const login = spawnSync("grok", ["login"], { stdio: "inherit", env: process.env });
  if (login.status !== 0) {
    die(`grok login failed (exit ${login.status ?? "spawn error"}). restore previous with: grok-auth use <old-name>`);
  }

  const auth = readAuth();
  if (!auth) die("login finished but auth.json missing");
  syncToProfile(name, auth);
  const m = loadMeta();
  m.active = name;
  saveMeta(m);
  const s = summarizeAuth(auth);
  ok(
    { name, email: s.email },
    `added and activated profile '${name}' (${s.email ?? "?"})`
  );
}

function cmdRemove(name?: string) {
  if (!name) die("usage: grok-auth remove <name>");
  const path = profilePath(name);
  const meta = loadMeta();
  if (!existsSync(path) && !meta.profiles[name]) die(`profile '${name}' not found`);
  if (existsSync(path)) unlinkSync(path);
  delete meta.profiles[name];
  if (meta.active === name) meta.active = null;
  saveMeta(meta);
  ok({ removed: name }, `removed profile '${name}'` + (meta.active === null ? " (was active — auth.json unchanged)" : ""));
}

function cmdRename(oldName?: string, newName?: string) {
  if (!oldName || !newName) die("usage: grok-auth rename <old> <new>");
  const from = profilePath(oldName);
  const to = profilePath(newName);
  if (!existsSync(from)) die(`profile '${oldName}' not found`);
  if (existsSync(to)) die(`profile '${newName}' already exists`);
  renameSync(from, to);
  const meta = loadMeta();
  meta.profiles[newName] = meta.profiles[oldName] ?? metaFromAuth(JSON.parse(readFileSync(to, "utf8")));
  delete meta.profiles[oldName];
  if (meta.active === oldName) meta.active = newName;
  saveMeta(meta);
  ok({ from: oldName, to: newName }, `renamed '${oldName}' → '${newName}'`);
}

function cmdSync() {
  const meta = loadMeta();
  if (!meta.active) {
    // invent name from email
    const auth = readAuth();
    if (!auth) die("no auth.json and no active profile");
    const name = defaultNameFromAuth(auth);
    syncToProfile(name, auth);
    const m = loadMeta();
    m.active = name;
    saveMeta(m);
    ok({ name }, `synced live auth into new profile '${name}'`);
    return;
  }
  const auth = syncToProfile(meta.active);
  const s = summarizeAuth(auth);
  ok(
    { name: meta.active, email: s.email, expires_at: s.expires_at },
    `synced live auth.json → profile '${meta.active}' (expires ${formatExpiry(s.expires_at)})`
  );
}

function printHelp() {
  console.log(`grok-auth — multi-account switcher for Grok CLI

Grok keeps one session in ~/.grok/auth.json. This tool snapshots that
file into named profiles under ~/.grok/accounts/profiles/ so you can
rotate accounts when token usage runs out.

Commands:
  list                     List saved accounts (* = active)
  current | whoami         Show live session + active profile
  save [name]              Snapshot current auth.json as profile
  use <name> | switch      Activate a saved profile
  next                     Rotate to the next saved profile
  add <name>               grok logout + login, then save as name
  remove <name> | rm       Delete a saved profile
  rename <old> <new>       Rename a profile
  sync                     Write live auth.json back into active profile

Flags:
  --json                   Machine-readable JSON output
  -h, --help               Show this help

Typical flow:
  1. grok login
  2. grok-auth save work
  3. grok-auth add personal     # browser login for 2nd account
  4. grok-auth list
  5. grok-auth next             # when quota exhausted
  6. restart 'grok' session

Notes:
  • Switching auto-syncs the previous profile so refreshed tokens
    (refresh_token / key) are not lost.
  • Restart running grok sessions after switching.
  • Unset XAI_API_KEY if set — it can override OIDC auth.json.
  • Profiles are chmod 600 under ~/.grok/accounts/

Paths:
  live:     ${AUTH_PATH}
  profiles: ${PROFILES_DIR}
  meta:     ${META_PATH}
`);
}

// ── main ───────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--json");
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    process.exit(0);
  }

  switch (cmd) {
    case "list":
    case "ls":
      cmdList();
      break;
    case "current":
    case "whoami":
    case "status":
      cmdCurrent();
      break;
    case "save":
      cmdSave(args[1]);
      break;
    case "use":
    case "switch":
    case "checkout":
      cmdUse(args[1]);
      break;
    case "next":
    case "rotate":
      cmdNext();
      break;
    case "add":
    case "login":
      cmdAdd(args[1]);
      break;
    case "remove":
    case "rm":
    case "delete":
      cmdRemove(args[1]);
      break;
    case "rename":
    case "mv":
      cmdRename(args[1], args[2]);
      break;
    case "sync":
      cmdSync();
      break;
    default:
      die(`unknown command '${cmd}'. run: grok-auth --help`);
  }
}

main();
