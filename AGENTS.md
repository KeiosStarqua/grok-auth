# AGENTS.md

## Mission

**authstash** is on a mission to become the **universal account switcher
for AI coding-agent CLIs** — Grok CLI, Kiro CLI, and whatever comes next.

Most agentic coding tools store exactly **one** authenticated session on
disk. When that session hits a rate limit, token quota, or you simply
want to use a different account, the tool itself gives you no way to
keep several identities around and hop between them. authstash fixes
that generically: it snapshots a tool's live auth state into named
profiles and swaps them back in on demand, per tool, with a single
consistent command surface (`list`, `save`, `use`, `next`, `add`,
`remove`, `rename`, `sync`).

The package originally shipped as a single-purpose tool for Grok CLI
(`grok-auth`). It is being generalized into `authstash`, a
multi-tool switcher, while keeping `grok-auth` fully working as a
backward-compatible alias.

## Architecture

- `src/core.ts` — tool-agnostic profile engine (paths, `meta.json`,
  save/use/next/remove/rename/sync/list/current). Operates purely
  against a `ToolAdapter`, with no knowledge of any specific CLI.
- `src/tools/<tool>.ts` — one adapter per supported coding-agent CLI.
  Each adapter says where that tool's live auth lives, how to
  read/write/summarize it, and (if possible) how to drive login/logout.
- `src/authstash.ts` — universal entrypoint: `authstash <tool> <command>`.
- `src/grok-auth.ts` — thin backward-compatible wrapper: same commands,
  bound to the Grok adapter, no `<tool>` argument needed.

Adding support for a new coding-agent CLI means writing one new
adapter file under `src/tools/` and registering it in
`src/authstash.ts`'s `TOOLS` map — the profile engine, CLI parsing,
and JSON/human output are already shared.

## Supported tools

| Tool | id | Live auth location | Automated login? |
|------|----|---------------------|-------------------|
| Grok CLI | `grok` | `~/.grok/auth.json` | yes, via `grok login` / `grok logout` |
| Kiro CLI | `kiro` | `~/.aws/sso/cache/kiro-auth-token.json` + its paired `<clientIdHash>.json` client registration | no — Kiro's OAuth/SSO sign-in is browser-driven; `add` prints manual sign-in instructions, then the user runs `save` |

Kiro does **not** store auth under `~/.kiro` — that directory only
holds config, agents, skills, sessions, and logs. The actual OIDC/SSO
session lives under `~/.aws/sso/cache/`, so the Kiro adapter snapshots
both files there as a pair (the token references its client
registration by `clientIdHash`, so they must travel together).

## Ground rules for contributors (human or agent)

1. **Never weaken the security posture.** Profile files and meta files
   are secrets (JWTs / OAuth tokens / refresh tokens) and must stay
   `chmod 600`. Do not log token values; summaries expose only
   non-secret metadata (email, expiry, provider/region, etc.).
2. **Keep `grok-auth` behavior unchanged.** It is a published npm
   package with real users; the on-disk layout under `~/.grok/accounts/`
   and its exact command/flag surface must remain backward compatible.
3. **New tool adapters only touch `src/tools/<tool>.ts`.** Do not bake
   tool-specific logic into `core.ts` or `authstash.ts`.
4. **Prefer explicit manual-login guidance over fragile automation.**
   If a tool's login flow can't be driven headlessly/safely (browser
   OAuth, MFA, etc.), do not attempt to script around it — surface a
   `manualLoginHint` instead, as the Kiro adapter does.
5. **Verify against the real file layout before trusting docs.** Coding
   agent CLIs change where they store auth between versions; read the
   actual files on a real machine (key names only, never values) before
   writing or changing an adapter.
