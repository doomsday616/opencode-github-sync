<p align="center">
  <img src="docs/banner.svg" alt="opencode-github-sync" width="820">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-github-sync"><img alt="npm" src="https://img.shields.io/npm/v/opencode-github-sync?style=flat-square&color=7aa2f7&labelColor=1a1e2b"></a>
  <a href="https://github.com/doomsday616/opencode-github-sync/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/doomsday616/opencode-github-sync/ci.yml?style=flat-square&color=9ece6a&labelColor=1a1e2b&label=ci"></a>
  <a href="./LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-bb9af7?style=flat-square&labelColor=1a1e2b"></a>
  <img alt="platform" src="https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-9ece6a?style=flat-square&labelColor=1a1e2b&label=runs%20on">
</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="#quick-start">Quick start</a>
  &nbsp;·&nbsp;
  <a href="#per-machine-overrides">Overrides</a>
  &nbsp;·&nbsp;
  <a href="#session-sync">Sessions</a>
  &nbsp;·&nbsp;
  <a href="#command-reference">Commands</a>
</p>

---

You use OpenCode on more than one machine. Your config, agents, commands, skills
and MCP servers live on whichever one you touched last.

**opencode-github-sync** keeps them all in step through a private GitHub
repository — as an OpenCode plugin, as a CLI, or both.

```bash
npm install -g opencode-github-sync
opencode-sync init          # creates the private repo and configures this machine
opencode-sync push
```

<p align="center">
  <img src="docs/demo.svg" alt="opencode-sync push" width="760">
</p>

---

## Why another sync tool

Most config-sync tools stop being safe the moment real use hits them. These are
the three places that happens, and what this one does instead.

|                    | Typical approach                                | Here                                                                       |
| ------------------ | ----------------------------------------------- | -------------------------------------------------------------------------- |
| **Machine differences** | Every machine forced identical               | [Per-machine overrides](#per-machine-overrides) that sync can never overwrite |
| **Sessions**       | Commit `opencode.db` — gigabytes, unmergeable    | [Selective per-session shards](#session-sync), a few MB, conflict-free      |
| **When it breaks** | Plugin-only: bad config means no way back        | The CLI runs outside OpenCode and can always recover you                    |

Plus the boring things that turn out to matter:

- **Symlinks are refused, not followed.** No copying files out of the machine by accident, no junction turning a delete into the wrong delete.
- **Every replacement is atomic.** A crash mid-sync cannot leave a half-written config that stops OpenCode from starting.
- **A push is verified against the remote.** `git push` can exit `0` without the remote moving; that is checked, not assumed.
- **Nothing runs twice at once.** A cross-process lock covers the plugin, the CLI and every OpenCode window.
- **Credentials are opt-in** and refused outright on a public repository.
- **Your hostname never leaves the machine.** Commits are signed with a stable pseudonym, so a corporate asset tag never lands in a repo that might not stay private.

---

## Install

### As an OpenCode plugin

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-github-sync"]
}
```

OpenCode installs it on the next start. The plugin adds a pull on startup, an
optional push when a session goes idle, and an `opencode_sync` tool so you can
just ask for a sync in plain language.

### As a CLI

```bash
npm install -g opencode-github-sync
```

Keep the CLI even if you use the plugin. A plugin cannot fix the configuration
that stops OpenCode from loading the plugin.

**Requirements** — git, and [`gh`](https://cli.github.com) for automatic setup.
Node 18+ for config sync; Node 22.5+ or Bun for [session sync](#session-sync).

---

## Quick start

### First machine

```bash
opencode-sync init                 # → <you>/my-opencode-config
opencode-sync init team-config     # custom name
opencode-sync init my-org/shared   # inside an organisation
opencode-sync push
```

`init` creates a **private** repository, writes
`~/.config/opencode/opencode-sync.jsonc`, and leaves an empty overrides file
ready for you.

### Every other machine

```bash
opencode-sync link doomsday616/my-opencode-config
opencode-sync pull
```

Then restart OpenCode.

### Day to day

```bash
opencode-sync push        # share what changed here
opencode-sync pull        # take what changed elsewhere
opencode-sync status      # what is in sync, what is not
```

---

## What gets synced

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture" width="880">
</p>

| Source                     | In the repo | Contents                                     |
| -------------------------- | ----------- | -------------------------------------------- |
| `~/.config/opencode/`      | repo root   | config, agents, commands, skills, themes, MCP |
| `~/.local/share/opencode/` | `_data/`    | project metadata, optional credentials        |
| `~/.local/state/opencode/` | `_state/`   | frecency, model cache, prompt history         |
| `~/.agents/skills/`        | `_agents/`  | skills installed by the `skills` CLI          |
| selected sessions          | `_sessions/`| one gzipped shard per session                 |

**Never synced:** `opencode.db` and its journals, tool output, snapshots, logs,
and your local settings and overrides files.

Add anything else with `extraPaths`:

```jsonc
{
  "extraPaths": [".tavily", ".config/gh/config.yml"]
}
```

---

## Per-machine overrides

A synced repository makes every machine identical. That is exactly wrong for the
settings that are genuinely machine-specific: a corporate proxy, a local
toolchain path, an MCP server that only exists on one box.

Put those in `~/.config/opencode/opencode-sync.overrides.jsonc`:

```jsonc
{
  "model": "github-copilot/claude-sonnet-4",
  "mcp": {
    "playwright": { "enabled": true }
  }
}
```

```
   repo opencode.jsonc        shared baseline, committed
 + overrides.jsonc            this machine only, never committed
 ─────────────────────────    deep merge
 = effective opencode.jsonc   what OpenCode actually reads
```

Merge rules: objects merge key by key, arrays and scalars replace, `null`
deletes a key.

The half that other tools get wrong is **push**. Because the effective file is
what sits on disk, a naive push uploads your overrides to everyone. Here, any
key the overrides file claims is restored to the value the repository already
had before committing — so an overridden key is invisible to sync in both
directions, and your machine keeps its own settings the whole time.

> With no overrides file the config is copied byte for byte and your comments
> and formatting are untouched. The structural rewrite only happens once you
> actually opt in.

---

## Session sync

Off by default. Turn it on only for a private repository — conversations are
private data.

```bash
opencode-sync sessions enable
opencode-sync sessions list
opencode-sync sessions include ses_065cad1caffeN3lf1RgLZno30   # pin one forever
opencode-sync sessions exclude ses_0ba19b4e7ffeMbSmWYi3Nj6xfZ  # never sync this one
```

### Why not just commit the database

A real OpenCode database reaches several gigabytes, almost all of it tool output
inside `part.data`. Git cannot delta-compress it, GitHub's LFS free tier is one
gigabyte, and copying a live database alongside its write-ahead log can capture
a torn state that only shows up much later.

So sessions are exported **one at a time**. Each becomes an independent gzipped
JSON shard holding its own rows plus the project and workspace rows it needs:

- **No large files.** Shards are small and compress well.
- **Conflicts isolate themselves.** Two machines working on different sessions
  touch different files, so git merges them with no special handling. The only
  real conflict is one session edited in two places, and there the newer
  `time_updated` wins — an in-progress conversation is never clobbered by a
  stale copy.
- **You choose what travels.** A time window, an explicit include list, a
  project filter and a per-session size cap. Ancient sessions stay where they
  are.

Import is an upsert inside a transaction, so a failure leaves your database
exactly as it was.

```jsonc
{
  "sessions": {
    "enabled": true,
    "days": 7,             // only sessions touched this recently
    "maxSessions": 50,     // hard cap per push, newest first
    "maxSessionBytes": 5242880,  // skip any single runaway session
    "include": [],         // always sync these, whatever the window says
    "exclude": [],         // never sync these
    "directories": []      // only sessions under these project directories
  }
}
```

> The internal `event` log is deliberately excluded. It is the largest table by
> row count and nothing about resuming a conversation depends on it.

---

## Command reference

| Command                            | What it does                                     |
| ---------------------------------- | ------------------------------------------------ |
| `opencode-sync init [name]`        | Create a private sync repository                  |
| `opencode-sync link <owner/repo>`  | Point this machine at an existing one             |
| `opencode-sync push`               | Share this machine's configuration                |
| `opencode-sync pull`               | Apply the shared configuration                    |
| `opencode-sync status`             | Show what is in sync and what is not              |
| `opencode-sync sessions list`      | Recent sessions and their ids                     |
| `opencode-sync sessions enable`    | Turn selective session sync on                    |
| `opencode-sync sessions include`   | Pin a session, ignoring the time window           |
| `opencode-sync overrides`          | Create/locate the per-machine patch               |
| `opencode-sync config`             | Print the current settings                        |

| Flag        | Effect                                          |
| ----------- | ----------------------------------------------- |
| `--force`   | Overwrite the other side on conflict (confirmed) |
| `--dry-run` | Report what would change, write nothing          |

| Environment variable         | Effect                                   |
| ---------------------------- | ---------------------------------------- |
| `OPENCODE_SYNC_HOST_ALIAS`   | Name this machine in commit messages     |
| `OPENCODE_SYNC_VERBOSE=1`    | Full file list and stack traces          |
| `NO_COLOR`                   | Disable colour                           |
| `SYNC_REMOTE_URL`            | Override the repository URL              |

---

## Settings

`~/.config/opencode/opencode-sync.jsonc` — never committed.

```jsonc
{
  "repo": { "owner": "you", "name": "my-opencode-config", "branch": "main" },

  "machineAlias": "laptop",     // optional; otherwise a stable pseudonym

  "includeCredentials": false,  // auth.json / account.json — private repos only
  "includeSkills": true,
  "includeState": true,
  "extraPaths": [],

  "sessions": { "enabled": false },

  "autoPullOnStartup": true,    // plugin only
  "autoPushOnIdle": false       // plugin only
}
```

---

## When something goes wrong

**A pull conflicted with local edits.** The worktree is rolled back to a clean
state and your changes stay in the stash. The exact recovery commands are
printed. Nothing is lost.

```bash
cd ~/.config/opencode
git stash list
git stash show -p stash@{0}
```

**"This machine has N commits that were never pushed."** Deliberate — pulling
would destroy them. Run `opencode-sync push`, or `pull --force` to discard.

**Authentication failed.** `gh auth login -h github.com`. The token needs the
`repo` scope for private repositories.

**Session sync says no SQLite driver.** Node 22.5+ or Bun. Config sync is
unaffected.

**Everything is broken and OpenCode will not start.** This is why the CLI
exists:

```bash
opencode-sync pull --force
```

---

## Development

```bash
npm install
npm run check     # lint + typecheck + tests
npm run build
```

The test suite runs against a real bare git repository on disk and simulates two
separate machines, so push, pull, force, rebase, stashing and the override
round-trip are all exercised end to end.

---

## Star history

<a href="https://star-history.com/#doomsday616/opencode-github-sync&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=doomsday616/opencode-github-sync&type=Date&theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=doomsday616/opencode-github-sync&type=Date">
    <img alt="Star history chart" src="https://api.star-history.com/svg?repos=doomsday616/opencode-github-sync&type=Date" width="640">
  </picture>
</a>

---

## License

[MIT](./LICENSE)

<p align="center">
  <sub>If this saved you some time, a ⭐ is appreciated.</sub>
</p>
