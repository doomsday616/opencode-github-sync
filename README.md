<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/en/01-hero.png" alt="opencode-github-sync: one config, every machine" width="880">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-github-sync"><img alt="npm" src="https://img.shields.io/npm/v/opencode-github-sync?style=flat-square&color=7aa2f7&labelColor=1a1e2b"></a>
  <a href="https://github.com/doomsday616/opencode-github-sync/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/doomsday616/opencode-github-sync/ci.yml?style=flat-square&color=9ece6a&labelColor=1a1e2b&label=ci"></a>
  <a href="https://github.com/doomsday616/opencode-github-sync/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-bb9af7?style=flat-square&labelColor=1a1e2b"></a>
  <img alt="platform" src="https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-9ece6a?style=flat-square&labelColor=1a1e2b&label=runs%20on">
</p>

<p align="center">
  <a href="https://github.com/doomsday616/opencode-github-sync/blob/main/README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="#install">Install</a>
  &nbsp;·&nbsp;
  <a href="#pick-your-setup">Setup</a>
  &nbsp;·&nbsp;
  <a href="#how-autosync-works">Autosync</a>
  &nbsp;·&nbsp;
  <a href="#command-reference">Commands</a>
  &nbsp;·&nbsp;
  <a href="#troubleshooting">Troubleshooting</a>
</p>

---

You use OpenCode on more than one computer. Your config, agents, commands,
skills and MCP servers end up wherever you last touched them.

**opencode-github-sync** keeps every machine on the same setup through a
private GitHub repository. Run it by hand, or let one machine sync itself in
the background.

## Install

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.sh | sh
```

**Windows** (PowerShell 5.1 or 7)

```powershell
irm https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.ps1 | iex
```

The installer checks for Node.js 18+ and git. If one is missing it shows the
command that would install it and asks before running anything. Then it runs
`npm install -g opencode-github-sync@latest` and opens the menu.

Already have Node.js? `npm install -g opencode-github-sync` and then
`opencode-sync` does the same thing.

### Set up a machine in one line

Pass options to skip the questions, for example when provisioning a new
machine:

```bash
curl -fsSL https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.sh | sh -s -- --mode auto --repo you/my-opencode-config
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.ps1))) -Mode auto -Repo you/my-opencode-config
```

| Option | Meaning |
| --- | --- |
| `--mode cli` / `-Mode cli` | Install the command only |
| `--mode link` | Link `--repo` and sync once |
| `--mode auto` | Link, sync once and turn on autosync |
| `--repo owner/name` | The repository (a git URL works too); created as private if it does not exist |
| `--interval N` | Autosync every N minutes (minimum 2, default 5) |
| `--lang en` / `zh-CN` | Interface language |
| `--proxy URL` | Proxy for npm and git, during install and for later syncs |
| `--yes` | Install missing Node.js or git without asking |
| `--package SPEC` | npm package spec to install (default `opencode-github-sync@latest`) |
| `--dry-run` | Print what would run, change nothing |

On Windows each option is the same word with a leading dash: `-Repo`,
`-Interval`, `-Lang`, `-Proxy`, `-Yes`, `-Package`, `-DryRun`.

When the repository already has content and this machine also has its own
files, setup takes the repository's version and keeps the replaced files in a
[recovery folder](#safety-features).

---

## Pick your setup

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/en/03-pick-your-setup.png" alt="Command only, or primary device with autosync" width="760">
</p>

The first time you run `opencode-sync` it asks how this machine should work.

| | Command only | Primary device + autosync |
| --- | --- | --- |
| How it syncs | You run `opencode-sync push` / `pull`, or the plugin pulls at startup | The operating system runs a sync every few minutes, even when OpenCode is closed |
| Good for | A machine you use now and then, a shared or locked-down machine | The machines you work on every day |
| Background job | None | Task Scheduler, launchd or a systemd timer |

You can change your mind any time from the **Autosync** menu. Autosync is
opt-in per machine: turning it on here never turns it on anywhere else.

---

## The menu

Run `opencode-sync` with no arguments.

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/menu.svg" alt="The opencode-sync menu" width="760">
</p>

Arrow keys or the shown hotkey pick an item, space ticks a checkbox, Enter
confirms and Esc goes back. When the input is not a terminal (a pipe, a script,
CI) every prompt becomes a numbered question, so the menu can be driven from a
file.

| Item | What you can do there |
| --- | --- |
| **Sync now** | Push and receive, receive only, push only, or preview first |
| **What to sync** | Tick main config, instruction files, agents, commands, plugins, skills, credentials, sessions; set session limits; add extra paths |
| **Autosync** | Turn it on or off, choose 5/10/15/30/60 minutes or your own interval, pause it, run while signed out (Windows), notifications |
| **Update** | Check npm for a newer version, upgrade, update automatically once a day |
| **This machine's overrides** | Open the overrides file in your editor, see what it changes |
| **Diagnostics** | git, node, gh, repository access, the scheduled job, the last log lines; export a support bundle |
| **Danger zone** | Make this machine match the repository, or the other way round (you type `overwrite` to confirm) |
| **Uninstall** | Remove the scheduled job, optionally unlink and remove the command. Your configuration is never deleted |
| **Network proxy** | A proxy for git, gh and npm, used only by opencode-sync |
| **Restore a file from history** | Pick a file, pick a version, put it back |
| **Devices** | Every machine that has synced and when, and renaming this one |
| **Large-change guard** | The limits that make a big push stop and ask |
| **Language** | English, 简体中文 or automatic |

Every command from earlier versions still works and is still scriptable.

---

## What gets synced

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/en/02-how-it-works.png" alt="Each machine pushes and pulls through one private repository" width="760">
</p>

Your `~/.config/opencode` folder becomes a working copy of the repository.
Everything else is mirrored into a folder inside it.

| On your machine | In the repository | What it holds |
| --- | --- | --- |
| `~/.config/opencode/` | the root | config, agents, commands, plugins, themes, instruction files |
| `~/.local/share/opencode/` | `_data/` | project metadata, and credentials if you opt in |
| `~/.local/state/opencode/` | `_state/` | model cache, recent files, prompt history |
| `~/.agents/skills/` | `_agents/` | skills installed with the `skills` CLI |
| selected sessions | `_sessions/` | one small compressed file per session |
| your extra paths | `_extra/` | anything else you add |

Each part can be switched off under **What to sync**. A part you switch off
stays local in both directions: your edits are not sent, and other machines'
versions do not replace yours.

**Never synced:** the `opencode.db` database, tool output, snapshots, logs,
`node_modules` and other generated folders, and opencode-sync's own settings
and overrides files.

---

## How autosync works

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/en/04-autosync.png" alt="Each machine syncs on its own schedule, waits while you edit, and backs off on errors" width="760">
</p>

When autosync is on, the operating system starts `opencode-sync autosync run`
every few minutes and at sign-in (on Windows also when you unlock or reconnect
over Remote Desktop). Each run makes one decision:

1. **Is it quiet?** If any file in your config or skills folders changed in the
   last minute, something is still being written. Sending now could publish a
   half-saved file, so the push waits.
2. **Can it at least receive?** While busy, it still takes other machines'
   changes, but only when this machine has nothing of its own waiting.
   Otherwise it leaves everything for the next run.
3. **Push and receive.** Your changes go up, other machines' changes come down,
   in one step.

The rules that keep this safe:

- **Machines take turns.** Each machine waits a fixed few seconds based on its
  name, so two machines on the same schedule do not collide every time. If
  another machine still gets there first, this one picks up the new commit and
  tries again; that does not count as an error.
- **It backs off, but never gives up.** After three failures in a row
  (typically no network) it waits 30 minutes, then an hour between attempts.
  The first success puts it back on schedule.
- **It only interrupts you twice.** One notification when it starts backing
  off, one when it recovers. Nothing for ordinary syncs.
- **It never runs twice at once.** A lock is shared by the scheduled job, the
  CLI, the menu and every OpenCode window; if one is busy, the others skip.
- **It never confirms a large change.** Anything that trips the
  [large-change guard](#safety-features) is held back and you get a
  notification.

| Platform | Scheduler | Notes |
| --- | --- | --- |
| Windows | Task Scheduler | Runs hidden. To run while signed out, turn that on in the menu and install from an administrator terminal |
| macOS | launchd agent | `~/Library/LaunchAgents/com.opencode-github-sync.autosync.plist` |
| Linux | systemd user timer | Falls back to a crontab line. On a server, run `loginctl enable-linger` so it runs while you are logged out |

`opencode-sync autosync status` shows the last run, the last error and when it
will try next. With autosync on, the OpenCode plugin stops pushing on idle so
the two never compete; it still pulls when OpenCode starts.

---

## Per-machine overrides

Some settings belong to one machine only: a work proxy, a local tool path, an
MCP server that only exists on one box. Put them in
`~/.config/opencode/opencode-sync.overrides.jsonc`, or use **This machine's
overrides** in the menu:

```jsonc
{
  "model": "github-copilot/claude-sonnet-4",
  "mcp": {
    "playwright": { "enabled": true }
  }
}
```

```
   repo opencode.jsonc        shared, committed
 + overrides.jsonc            this machine only, never committed
 ─────────────────────────    merged
 = effective opencode.jsonc   what OpenCode reads
```

Objects merge key by key, lists and plain values replace, and `null` removes a
key. Before every push, any key the overrides file claims is put back to the
repository's value, so your machine-only values never reach other machines.
Without an overrides file, the config is copied exactly as written, comments
and all.

---

## Sessions

Off by default. Only turn it on for a private repository: conversations are
private.

```bash
opencode-sync sessions enable
opencode-sync sessions list
opencode-sync sessions include ses_065cad1caffeN3lf1RgLZno30   # always sync this one
opencode-sync sessions exclude ses_0ba19b4e7ffeMbSmWYi3Nj6xfZ  # never sync this one
```

Sessions are not synced by committing the database. A real OpenCode database
grows to several gigabytes, mostly tool output, and git cannot merge it. Each
session is exported on its own as a small compressed file instead:

- **Small.** Only recent sessions (7 days and 50 sessions by default), and any
  single session over 5 MB is skipped.
- **No conflicts in practice.** Two machines working on different sessions
  touch different files. The same session edited in two places keeps the newer
  version.
- **Safe to import.** Importing runs in one transaction, so a failure leaves
  your database as it was.

Window, count and size limits are under **What to sync → Session settings**.
Session sync needs Node.js 22.5 or newer.

---

## Safety features

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/en/05-safety-net.png" alt="One sync at a time, all-or-nothing writes, restore earlier versions, large-change guard" width="760">
</p>

- **Atomic replace.** Files are written beside their target and then swapped
  in, so a crash mid-sync cannot leave a half-written config that stops
  OpenCode from starting.
- **Push verification.** After pushing, the remote is read back. `git push`
  can report success without the remote changing; that is checked, not
  assumed.
- **One sync at a time.** A lock shared by the plugin, the CLI, the menu and
  the scheduled job.
- **Large-change guard.** A push that adds more than 300 files, more than
  10 MB in total, or any single file over 2 MB stops and asks. The limits are
  adjustable. Generated folders such as `node_modules`, `.venv`, `venv`,
  `__pycache__`, `dist` and `.cache` are never sent.
- **Recovery folder.** Before a forced pull, a "repository wins" first link,
  or a restore from history, the files about to be replaced are copied to
  `~/.local/share/opencode/opencode-sync-recovery/<time>-<reason>/`.
- **Credentials are opt-in** and refused outright when the repository is
  public.
- **Your hostname stays private.** Commits name the machine by a stable
  pseudonym (or a name you choose), never by its real hostname.
- **Symlinks are refused, not followed**, so a sync cannot copy files from
  outside the folders it owns.

---

## OpenCode plugin

The plugin is optional. It pulls when OpenCode starts, can push when a session
goes idle, and adds an `opencode_sync` tool so you can ask for a sync in plain
language.

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-github-sync"]
}
```

This `"plugin"` form works on both OpenCode 1.x (1.3.4 and later) and
OpenCode 2.x: 1.x reads only `"plugin"`, and 2.x still accepts it alongside its
native `"plugins"` key. If you run only OpenCode 2, you can list it under
`"plugins"` instead. Do not list the plugin under both keys — OpenCode 2 loads
entries from both lists.

OpenCode 1.0–1.3.3 cannot load 3.1.0 and later; stay on
`opencode-github-sync@3.0.1` there.

Keep the command installed even if you use the plugin. A plugin cannot repair
the configuration that stops OpenCode from loading it; `opencode-sync pull
--force` can.

---

## Command reference

| Command | What it does |
| --- | --- |
| `opencode-sync` | Open the menu (same as `opencode-sync menu`) |
| `opencode-sync init [name]` | Create a private sync repository with `gh` |
| `opencode-sync link <owner/repo or URL>` | Use an existing repository |
| `opencode-sync setup --mode cli\|link\|auto` | Non-interactive setup, used by the installers |
| `opencode-sync push` | Send this machine's changes |
| `opencode-sync pull` | Take the shared configuration |
| `opencode-sync status` | What is in sync and what is not |
| `opencode-sync autosync enable` / `disable` | Turn autosync on or off for this machine |
| `opencode-sync autosync install` / `uninstall` | Register or remove the scheduled job only |
| `opencode-sync autosync status` | Last run, last error, next attempt |
| `opencode-sync autosync run` | One scheduled pass, now |
| `opencode-sync autosync pause <hours>\|tomorrow` / `resume` | Pause or resume |
| `opencode-sync autosync reset` | Clear the failure counter |
| `opencode-sync sessions list\|enable\|disable` | Session sync |
| `opencode-sync sessions include\|exclude <id>` | Always or never sync one session |
| `opencode-sync overrides` | Create or locate the overrides file |
| `opencode-sync config` | Print the settings |

| Flag | Effect |
| --- | --- |
| `--force` | Overwrite the other side (asks you to type `yes`; `--yes` skips) |
| `--dry-run` | Show what would change, change nothing |
| `--allow-large` | Push even when the large-change guard objects |
| `--lang en\|zh-CN` | Interface language for this run |

| Environment variable | Effect |
| --- | --- |
| `OPENCODE_SYNC_LANG` | Interface language |
| `OPENCODE_SYNC_HOST_ALIAS` | Machine name used in commits |
| `OPENCODE_SYNC_PROXY` | Proxy for git, gh and npm |
| `OPENCODE_SYNC_VERBOSE=1` | Full file lists and stack traces |
| `SYNC_REMOTE_URL` | Override the repository URL |
| `NO_COLOR` | Plain output |

### Settings file

`~/.config/opencode/opencode-sync.jsonc` stays on this machine and is never
committed. The menu edits it for you; every key is optional.

```jsonc
{
  "repo": { "owner": "you", "name": "my-opencode-config", "branch": "main" },
  "machineAlias": "laptop",
  "includeCredentials": false,
  "includeSkills": true,
  "includeState": true,
  "extraPaths": [".config/gh/config.yml"],
  "categories": { "config": true, "instructions": true, "agents": true, "commands": true, "plugins": true },
  "sessions": { "enabled": false, "days": 7, "maxSessions": 50, "maxSessionBytes": 5242880 },
  "autosync": { "enabled": false, "intervalMinutes": 5, "settleSeconds": 60, "runWhenLoggedOff": false, "autoUpdate": false },
  "guard": { "maxFiles": 300, "maxBytes": 10485760, "maxFileBytes": 2097152 },
  "proxy": "",
  "language": "",
  "notifications": true,
  "autoPullOnStartup": true,
  "autoPushOnIdle": false
}
```

---

## Troubleshooting

**I am behind a proxy.** Pass `--proxy http://host:port` (or `-Proxy` on
Windows) to the installer. It is used for npm and git during the install and
saved for later syncs. You can change it any time under **Network proxy**.

**`curl | sh` does not ask me anything.** The script itself arrives through the
pipe, so it reads your answers from the terminal instead. In a session with no
terminal (CI, a Dockerfile) there is nobody to ask: pass `--mode` and `--repo`,
plus `--yes` if Node.js or git may need installing.

**Windows says running scripts is disabled.** `irm ... | iex` does not run a
script file, so the execution policy does not apply to it. If you downloaded
`install.ps1` and want to run it as a file, use
`powershell -ExecutionPolicy Bypass -File install.ps1`.

**`opencode-sync` is not found after installing.** npm installed it into a
folder that is not on your `PATH`. `npm prefix -g` shows the folder; add its
`bin` (or the folder itself on Windows) to `PATH`.

**Autosync is on but nothing happens.** Run `opencode-sync autosync status`. It
shows whether it is paused, backing off after errors, or waiting because files
are still changing. **Diagnostics** in the menu shows whether the scheduled job
is registered.

**A pull conflicted with my local edits.** Your edits are kept in a git stash
and the exact commands to get them back are printed. Nothing is lost.

**"This machine has N commits that were never pushed."** Pulling would throw
them away, so it stops. Run `opencode-sync push`, or `pull --force` to discard
them.

**Authentication failed.** Run `gh auth login -h github.com`. Private
repositories need the `repo` scope.

**OpenCode will not start after a sync.** This is what the command is for:

```bash
opencode-sync pull --force
```

The files it replaces go to the recovery folder first.

---

## Upgrading from 3.1.x

```bash
npm install -g opencode-github-sync@latest
```

Nothing else is required: your settings, overrides and repository keep
working, and autosync stays off until you turn it on. If you were using a
script of your own to sync on a timer, remove it before turning autosync on so
the two do not compete. If you used `autoPushOnIdle` in the plugin, autosync
replaces it on machines where you turn it on.

---

## Development

```bash
npm install
npm run check     # lint, typecheck and tests
npm run build
```

The tests run against real git repositories on disk and simulate several
machines, so pushing, pulling, rebasing, autosync scheduling and the menu are
exercised end to end. Real scheduled jobs are only ever registered on
disposable CI runners.

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

[MIT](https://github.com/doomsday616/opencode-github-sync/blob/main/LICENSE)

<p align="center">
  <sub>If this saved you some time, a ⭐ is appreciated.</sub>
</p>
