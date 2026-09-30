#!/usr/bin/env node
/**
 * authstash — universal multi-account switcher for AI coding-agent CLIs.
 *
 * Many agentic CLIs (Grok CLI, Kiro CLI, ...) only keep ONE session on
 * disk at a time. authstash snapshots that session into named profiles
 * per tool and lets you rotate between them safely — e.g. when a
 * usage/token quota runs out.
 *
 * Usage:
 *   authstash <tool> <command> [args] [--json]
 *
 * Tools:
 *   grok    Grok CLI      (~/.grok/auth.json)
 *   kiro    Kiro CLI      (~/.aws/sso/cache/kiro-auth-token.json)
 *
 * Commands (same across all tools):
 *   list | current | save [name] | use <name> | next |
 *   add <name> | remove <name> | rename <old> <new> | sync
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
  type ToolAdapter,
} from "./core.js";
import { grokTool } from "./tools/grok.js";
import { kiroTool } from "./tools/kiro.js";

const TOOLS: Record<string, ToolAdapter> = {
  grok: grokTool,
  kiro: kiroTool,
};

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

function printWarnings(t: ToolAdapter) {
  if (!t.warnings) return;
  for (const w of t.warnings()) console.error(w);
}

function printHelp() {
  const toolLines = Object.values(TOOLS)
    .map((t) => `  ${t.id.padEnd(8)}${t.displayName}`)
    .join("\n");
  console.log(`authstash — universal account switcher for AI coding-agent CLIs

Many agent CLIs keep only one session on disk. authstash snapshots that
session into named profiles per tool so you can rotate accounts when a
usage/token quota runs out.

Usage:
  authstash <tool> <command> [args...] [--json]

Tools:
${toolLines}

Commands:
  list                     List saved profiles (* = active)
  current | whoami         Show live session + active profile
  save [name]              Snapshot current live auth as a profile
  use <name> | switch      Activate a saved profile
  next                     Rotate to the next saved profile
  add <name>               Start a new account, then save as name
  remove <name> | rm       Delete a saved profile
  rename <old> <new>       Rename a profile
  sync                     Write live auth back into the active profile

Flags:
  --json                   Machine-readable JSON output
  -h, --help               Show this help

Examples:
  authstash kiro save work
  authstash kiro add personal
  authstash kiro next
  authstash grok list --json
`);
}

function printToolHelp(t: ToolAdapter) {
  console.log(`authstash ${t.id} — profile switcher for ${t.displayName}

Commands:
  list                     List saved profiles (* = active)
  current | whoami         Show live session + active profile
  save [name]              Snapshot current live auth as a profile
  use <name> | switch      Activate a saved profile
  next                     Rotate to the next saved profile
  add <name>               Start a new account, then save as name
  remove <name> | rm       Delete a saved profile
  rename <old> <new>       Rename a profile
  sync                     Write live auth back into the active profile

Flags:
  --json                   Machine-readable JSON output
`);
}

function runList(t: ToolAdapter) {
  const { active, live, rows } = listProfiles(t);
  if (jsonOut) {
    ok({ active, live, profiles: rows });
    return;
  }
  if (rows.length === 0) {
    console.log(`no saved profiles for ${t.displayName}. run: authstash ${t.id} save [name]`);
    return;
  }
  console.log(`tool:   ${t.displayName}`);
  console.log(`active: ${active ?? "(none)"}`);
  console.log(live.present ? `live:   ${live.label ?? "?"}  expires ${formatExpiry(live.expires_at as string | undefined)}` : "live:   (no session)");
  console.log("");
  const w = Math.max(8, ...rows.map((r) => r.name.length));
  for (const r of rows) {
    const mark = r.active ? "*" : " ";
    console.log(`${mark} ${r.name.padEnd(w)}  ${(r.label ?? "-").padEnd(32)}  exp ${r.expires}`);
  }
  console.log("\n* = active profile");
}

function runCurrent(t: ToolAdapter) {
  const { active, live, profile } = currentProfile(t);
  if (jsonOut) {
    ok({ active, live, profile });
    return;
  }
  if (!live.present) {
    console.log(`no active ${t.displayName} session`);
    console.log(`run: authstash ${t.id} save <name>  (after logging in normally)`);
    return;
  }
  console.log(`tool:     ${t.displayName}`);
  console.log(`profile:  ${active ?? "(unsaved)"}`);
  console.log(`label:    ${live.label ?? "-"}`);
  console.log(`expires:  ${formatExpiry(live.expires_at as string | undefined)} (${live.expires_at ?? "-"})`);
  printWarnings(t);
}

function main() {
  const rawArgs = process.argv.slice(2).filter((a) => a !== "--json");
  const toolId = rawArgs[0];

  if (!toolId || toolId === "-h" || toolId === "--help" || toolId === "help") {
    printHelp();
    process.exit(0);
  }

  const t = TOOLS[toolId];
  if (!t) {
    fail(`unknown tool '${toolId}'. available: ${Object.keys(TOOLS).join(", ")}`);
  }

  const cmd = rawArgs[1];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    printToolHelp(t);
    process.exit(0);
  }

  try {
    switch (cmd) {
      case "list":
      case "ls":
        runList(t);
        break;
      case "current":
      case "whoami":
      case "status":
        runCurrent(t);
        break;
      case "save": {
        const { name, summary } = saveProfile(t, rawArgs[2]);
        ok({ name, ...summary }, `saved profile '${name}' (${summary.label ?? "?"}) and set active`);
        break;
      }
      case "use":
      case "switch":
      case "checkout": {
        const { name, summary } = useProfile(t, rawArgs[2]);
        printWarnings(t);
        ok(
          { active: name, ...summary },
          `switched to '${name}' (${summary.label ?? "?"})\nnote: restart any running ${t.id} sessions to pick up the new account`
        );
        break;
      }
      case "next": {
        const r = nextProfile(t);
        if (r.onlyOne) {
          ok({ active: r.name }, `only one profile ('${r.name}') — nothing to rotate`);
        } else {
          ok({ active: r.name, ...(r.summary ?? {}) }, `rotated to '${r.name}' (${r.summary?.label ?? "?"})`);
        }
        break;
      }
      case "add":
      case "login": {
        const { name, summary } = addProfile(t, rawArgs[2]);
        ok({ name, ...summary }, `added and activated profile '${name}' (${summary.label ?? "?"})`);
        break;
      }
      case "remove":
      case "rm":
      case "delete": {
        const { removed, wasActive } = removeProfile(t, rawArgs[2]);
        ok({ removed }, `removed profile '${removed}'` + (wasActive ? " (was active — live auth unchanged)" : ""));
        break;
      }
      case "rename":
      case "mv": {
        const { from, to } = renameProfile(t, rawArgs[2], rawArgs[3]);
        ok({ from, to }, `renamed '${from}' → '${to}'`);
        break;
      }
      case "sync": {
        const { name, summary } = syncProfile(t);
        ok({ name, ...summary }, `synced live auth → profile '${name}' (expires ${formatExpiry(summary.expires_at as string | undefined)})`);
        break;
      }
      default:
        fail(`unknown command '${cmd}'. run: authstash ${t.id} --help`);
    }
  } catch (e) {
    if (e instanceof AuthstashError) {
      fail(e.message, e.code);
    }
    fail(e instanceof Error ? e.message : String(e));
  }
}

main();
