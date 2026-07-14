# grok-auth

Switch between multiple Grok CLI accounts when you run out of token usage.

Grok stores **one** OIDC session in `~/.grok/auth.json`. This tool snapshots that file into named profiles and swaps them safely.

## Install

Requires [Bun](https://bun.sh).

```bash
git clone <this-repo> ~/repos/mein/grok-auth   # or your path
chmod +x ~/repos/mein/grok-auth/grok-auth.ts
ln -sfn ~/repos/mein/grok-auth/grok-auth.ts ~/.local/bin/grok-auth
# ensure ~/.local/bin is on PATH
grok-auth --help
```

## Quick start

```bash
# 1. Log into account A and save it
grok login
grok-auth save work

# 2. Add a second account (runs logout + login, then saves)
grok-auth add personal

# 3. See what's stored
grok-auth list

# 4. When quota is exhausted, rotate
grok-auth next
# or: grok-auth use work

# 5. Restart any running `grok` session
```

## Commands

| Command | Description |
|---------|-------------|
| `list` | List profiles (`*` = active) |
| `current` / `whoami` | Live session + active profile |
| `save [name]` | Snapshot current `auth.json` |
| `use <name>` | Activate a profile |
| `next` | Round-robin to next profile |
| `add <name>` | `grok logout` + `login`, then save |
| `remove <name>` | Delete profile (does not clear live auth) |
| `rename <old> <new>` | Rename profile |
| `sync` | Write live `auth.json` back into active profile |

Flag: `--json` for machine-readable output.

## How it works

```
~/.grok/
  auth.json                 ← what Grok CLI actually reads
  accounts/
    meta.json               ← active name + profile metadata
    profiles/
      work.json             ← full auth.json snapshot
      personal.json
```

On every `use` / `next` / `add`, the **current** live session is written back into its profile first. That preserves silent token refreshes Grok does mid-session (`key` + `refresh_token`).

## Notes

1. **Restart Grok** after switching — running processes keep the old token in memory.
2. Unset `XAI_API_KEY` if set; depending on Grok version it can override or confuse session auth.
3. Profile files are `chmod 600`. Treat them like passwords (they contain JWT + refresh tokens).
4. Tokens expire (~hours for access; refresh extends the session). Run `grok-auth sync` after a long Grok session if you plan to switch away later.
5. This does **not** bypass xAI rate limits illegally — it only lets you use accounts you already own and authenticated.

## Exit codes

- `0` — success
- `1` — error (missing profile, no auth, bad name, login failed)
