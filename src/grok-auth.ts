#!/usr/bin/env node
/**
 * grok-auth — switch between multiple Grok CLI OIDC accounts.
 *
 * This is a thin, backward-compatible wrapper around authstash's
 * generic profile engine (core.ts) bound to the Grok adapter
 * (tools/grok.ts). On-disk layout (~/.grok/accounts/...) and command
 * surface are unchanged from the original standalone tool.
 *
 * Prefer `authstash grok <command>` for new scripts; `grok-auth
 * <command>` remains supported as an alias.
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

import {
  AuthstashError,
  formatExpiry,
  listProfiles,
  currentProfile,
  saveProfile,
  useProfile,
  nextProfile,
  removeProfile,
  renameProfile,
  syncProfile,
  addProfile,
} from "./core.js";
import { grokTool as t, GROK_AUTH_PATH } from "./tools/grok.js";
import { profilesDir, metaPath } from "./core.js";

const jsonOut = process.argv.includes("--json");

function ok(data: unknown, human?: string) {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: true, ...((typeof data === "object" && data !== null) ? data as object : { data }) }));
  } else if (human) {
    console.log(human);
  } else if (data !== undefined) {
    console.log(typeof data === "string" ? data : JSON.stringify(data, null, 2));
  }
}

function fail(msg: string, code = 1): never {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: msg }));
  } else {
    console.error(`error: ${msg}`);
  }
  process.exit(code);
}

function printWarnings() {
  if (!t.warnings) return;
  for (const w of t.warnings()) console.error(w);
}

function cmdList() {
  const { active, live, rows } = listProfiles(t);
  if (jsonOut) {
    ok({ active, live, profiles: rows });
    return;
  }
  if (rows.length === 0) {
    ok(undefined, "no saved accounts. run: grok-auth save [name]");
    return;
  }
  console.log(`active: ${active ?? "(none)"}`);
  console.log(live.present ? `live:   ${live.label ?? "?"}  expires ${formatExpiry(live.expires_at as string | undefined)}` : "live:   (no auth.json)");
  console.log("");
  const w = Math.max(8, ...rows.map((r) => r.name.length));
  for (const r of rows) {
    const mark = r.active ? "*" : " ";
    console.log(`${mark} ${r.name.padEnd(w)}  ${(r.label ?? "-").padEnd(32)}  exp ${r.expires}`);
  }
  console.log("\n* = active profile");
}

function cmdCurrent() {
  const { active, live, profile } = currentProfile(t);
  if (jsonOut) {
    ok({ active, live, profile });
    return;
  }
  if (!live.present) {
    console.log("no active grok session (missing auth.json)");
    console.log("run: grok login && grok-auth save <name>");
    return;
  }
  console.log(`profile:  ${active ?? "(unsaved)"}`);
  console.log(`email:    ${live.email ?? "-"}`);
  console.log(`name:     ${[live.first_name, live.last_name].filter(Boolean).join(" ") || "-"}`);
  console.log(`user_id:  ${live.user_id ?? "-"}`);
  console.log(`team_id:  ${live.team_id ?? "-"}`);
  console.log(`mode:     ${live.auth_mode ?? "-"}`);
  console.log(`expires:  ${formatExpiry(live.expires_at as string | undefined)} (${live.expires_at ?? "-"})`);
  printWarnings();
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
  -h, --help                Show this help

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
  • This CLI now also ships as 'authstash grok <command>', part of the
    universal authstash switcher for coding-agent CLIs.

Paths:
  live:     ${GROK_AUTH_PATH}
  profiles: ${profilesDir(t)}
  meta:     ${metaPath(t)}
`);
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--json");
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printHelp();
    process.exit(0);
  }

  try {
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
      case "save": {
        const { name, summary } = saveProfile(t, args[1]);
        ok({ name, email: summary.email, expires_at: summary.expires_at }, `saved profile '${name}' (${summary.label ?? "?"}) and set active`);
        break;
      }
      case "use":
      case "switch":
      case "checkout": {
        const { name, summary } = useProfile(t, args[1]);
        printWarnings();
        ok(
          { active: name, email: summary.email, expires_at: summary.expires_at },
          `switched to '${name}' (${summary.label ?? "?"})\nnote: restart any running 'grok' sessions to pick up the new account`
        );
        break;
      }
      case "next":
      case "rotate": {
        const r = nextProfile(t);
        if (r.onlyOne) {
          ok({ active: r.name }, `only one profile ('${r.name}') — nothing to rotate`);
        } else {
          ok({ active: r.name, email: r.summary?.email, expires_at: r.summary?.expires_at }, `switched to '${r.name}' (${r.summary?.label ?? "?"})\nnote: restart any running 'grok' sessions to pick up the new account`);
        }
        break;
      }
      case "add":
      case "login": {
        const { name, summary } = addProfile(t, args[1]);
        ok({ name, email: summary.email }, `added and activated profile '${name}' (${summary.label ?? "?"})`);
        break;
      }
      case "remove":
      case "rm":
      case "delete": {
        const { removed, wasActive } = removeProfile(t, args[1]);
        ok({ removed }, `removed profile '${removed}'` + (wasActive ? " (was active — auth.json unchanged)" : ""));
        break;
      }
      case "rename":
      case "mv": {
        const { from, to } = renameProfile(t, args[1], args[2]);
        ok({ from, to }, `renamed '${from}' → '${to}'`);
        break;
      }
      case "sync": {
        const { name, summary } = syncProfile(t);
        ok({ name, email: summary.email, expires_at: summary.expires_at }, `synced live auth.json → profile '${name}' (expires ${formatExpiry(summary.expires_at as string | undefined)})`);
        break;
      }
      default:
        fail(`unknown command '${cmd}'. run: grok-auth --help`);
    }
  } catch (e) {
    if (e instanceof AuthstashError) {
      fail(e.message, e.code);
    }
    fail(e instanceof Error ? e.message : String(e));
  }
}

main();
