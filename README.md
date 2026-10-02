# authstash

Universal account switcher for AI coding-agent CLIs. Most agentic CLIs
(Grok CLI, Kiro CLI, ...) keep **one** authenticated session on disk.
authstash snapshots that session into named profiles per tool and lets
you rotate between them on demand — e.g. when a usage/token quota runs
out.

This package also ships `grok-auth`, the original single-tool Grok
switcher, as a fully backward-compatible alias.

## Install

Requires **Node.js 18+**. Install from npm with any Node-compatible package manager:

```bash
# npm
npm i -g grok-auth
npx authstash --help

# pnpm
pnpm add -g grok-auth
pnpm dlx authstash --help

# yarn
yarn global add grok-auth
# or one-shot without a global install:
npx authstash --help

# bun
bun add -g grok-auth
bunx authstash --help

# Deno (needs FS access to ~/.grok, ~/.kiro, ~/.aws)
deno install -g -A npm:grok-auth
# or: deno run -A npm:grok-auth --help
```

**Runtime dependency:** for Grok, the official `grok` CLI must be on `PATH` for `add` / interactive login flows (`grok logout`, `grok login`). Profile list/switch/save/sync only need this package. Kiro has no automated login (see below) so it has no such dependency.

### From source (contributors)

```bash
git clone https://github.com/KeiosStarqua/grok-auth.git
cd grok-auth
npm install
npm run build
node dist/authstash.js --help
node dist/grok-auth.js --help
# optional: npm link  (or symlink dist/*.js onto PATH)
```

## Quick start — universal CLI

```bash
authstash <tool> <command> [args] [--json]
```

### Grok CLI

```bash
grok login
authstash grok save work
authstash grok add personal   # grok logout + login, then save
authstash grok list
authstash grok next           # when quota exhausted
```

### Kiro CLI

Kiro's sign-in is browser-based OAuth/SSO — authstash cannot drive it
headlessly, so there's no `add`-style automated login. Sign in through
Kiro's own flow, then snapshot it:

```bash
# 1. Sign in to Kiro normally (browser-driven)
authstash kiro save work

# 2. Sign out / sign in as a different account in Kiro
authstash kiro save personal

# 3. Rotate accounts later
authstash kiro list
authstash kiro next
# or: authstash kiro use work
```

Restart Kiro CLI sessions after switching so they pick up the new token.

## Commands (same across all tools)

| Command | Description |
|---------|-------------|
| `list` | List profiles (`*` = active) |
| `current` / `whoami` | Live session + active profile |
| `save [name]` | Snapshot current live auth |
| `use <name>` | Activate a profile |
| `next` | Round-robin to next profile |
| `add <name>` | Automated login (if supported) + save |
| `remove <name>` | Delete profile (does not clear live auth) |
| `rename <old> <new>` | Rename profile |
| `sync` | Write live auth back into the active profile |

Flag: `--json` for machine-readable output.

## Supported tools

| Tool | id | Live auth location | Automated `add` login? |
|------|----|---------------------|-------------------------|
| Grok CLI | `grok` | `~/.grok/auth.json` | yes, via `grok login` / `grok logout` |
| Kiro CLI | `kiro` | `~/.local/share/kiro-cli/data.sqlite3` (tables `auth_kv` + auth rows of `state`; macOS: `~/Library/Application Support/kiro-cli/`) | no — sign in manually, then run `save` |

## How it works (Grok example)

```
~/.grok/
  auth.json                 ← what Grok CLI actually reads
  accounts/
    meta.json               ← active name + profile metadata
    profiles/
      work.json             ← full auth.json snapshot
      personal.json
```

Kiro follows the same pattern under `~/.kiro/accounts/`. Kiro CLI keeps
its session in SQLite (`~/.local/share/kiro-cli/data.sqlite3`), so each
profile snapshots every `auth_kv` row (OIDC token + device registration)
plus the identity rows of `state` (IdC start URL/region, CodeWhisperer
profile ARN). The account email comes from `kiro-cli whoami`. Kiro
support needs **Node.js ≥22.13** (built-in `node:sqlite`). Profiles
saved by authstash 1.0.0 from `~/.aws/sso/cache` are legacy — Kiro no
longer reads that file; sign in again and re-`save` them.

If you log in to another account directly through `kiro-cli`, authstash
detects that the live session no longer matches the active profile and
will not overwrite that profile (`current` shows a warning, `sync`
refuses).

On every `use` / `next` / `add`, the **current** live session is written
back into its profile first. That preserves silent token refreshes a
tool does mid-session (e.g. Grok's `key` + `refresh_token`).

## Backward-compatible: `grok-auth`

The original Grok-only CLI still works exactly as before, same commands,
same on-disk layout:

```bash
grok-auth save work
grok-auth add personal
grok-auth list
grok-auth next
```

See `authstash grok <command>` for the equivalent universal-CLI form.

## Notes

1. **Restart the coding-agent CLI** after switching — running processes keep the old token in memory.
2. For Grok, unset `XAI_API_KEY` if set; depending on Grok version it can override or confuse session auth.
3. Profile files and `meta.json` are `chmod 600`. Treat them like passwords (they contain JWT / OAuth / refresh tokens).
4. Tokens expire; refresh tokens extend the session where the tool supports it. Run `sync` after a long session if you plan to switch away later.
5. This does **not** bypass any provider's rate limits illegally — it only lets you use accounts you already own and authenticated.

## Exit codes

- `0` — success
- `1` — error (missing profile, no auth, bad name, login failed)
- `2` — manual action required (e.g. Kiro's `add` needs interactive browser sign-in first)
