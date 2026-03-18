<p align="center">
  <img src="docs/banner.svg" alt="opencode-github-sync" width="700"/>
</p>

<p align="center">
  <strong>Sync your OpenCode world across every machine</strong>
</p>

<p align="center">
  <a href="./README.zh-CN.md">简体中文</a> ｜ English
</p>

<p align="center">
  <a href="https://github.com/doomsday616/opencode-github-sync/releases"><img src="https://img.shields.io/github/v/release/doomsday616/opencode-github-sync?style=flat-square&color=38bdf8" alt="Release"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/doomsday616/opencode-github-sync?style=flat-square&color=818cf8" alt="License"/></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-34d399?style=flat-square" alt="Platform"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-fbbf24?style=flat-square" alt="Node"/>
</p>

---

## The Problem

You use [OpenCode](https://opencode.ai) on multiple machines — a MacBook at the coffee shop, a Windows desktop at home. Your config, skills, MCP settings, and session history are stuck on whichever machine you last used.

## The Solution

**opencode-github-sync** merges four local directories into one private GitHub repo and syncs them with simple push/pull commands.

```
~/.config/opencode/       →  repo root      (config, skills, commands, MCP)
~/.local/share/opencode/  →  _data/         (auth, sync-state, SQLite db)
~/.local/state/opencode/  →  _state/        (frecency, kv store, model cache)
~/.agents/skills/         →  _agents/       (skills CLI installs + lock file)
```

## How It Works

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture Diagram" width="700"/>
</p>

<p align="center">
  <img src="docs/demo.svg" alt="Demo" width="600"/>
</p>

## Features

| Feature | Description |
|---|---|
| 🔄 **Config Sync** | Push/pull config files, skills, and state across machines |
| 💾 **Session Sync** | Safe SQLite backup via `.backup` — runs outside OpenCode to avoid corruption |
| 📦 **Auto-stash** | Local changes automatically stashed during pull |
| 💪 **Force Mode** | `--force` to overwrite on conflict (push or pull) |
| 🗃️ **Git LFS** | Large binary files (SQLite db) tracked via Git LFS |
| 🔧 **Migration Repair** | Auto-restores migration records when pulling an older database |
| 🖥️ **Cross-platform** | macOS (zsh) + Windows (PowerShell 7) |

## New to This? Let OpenCode Do It For You

If you're not familiar with Git, GitHub CLI, or environment variables — no worries. Just paste this prompt into OpenCode and let it handle everything:

```
I want to sync my OpenCode config and sessions across multiple machines.
Help me set up everything from scratch:

1. Check if Git, Git LFS, Node.js, and SQLite3 are installed — install anything missing
2. Check if gh (GitHub CLI) is installed — if not, install it, then help me log in to GitHub
3. Create a private GitHub repo for storing my sync data
4. Clone the opencode-github-sync project, install the scripts and wrappers to the correct locations
5. Set the SYNC_REMOTE_URL environment variable for me
6. Run opencode-push once (config only) to test that everything works

Note: Session sync must be run in a terminal OUTSIDE of OpenCode (it needs to shut down
OpenCode to safely copy the database). Just prepare the command for me and I'll run it myself.
```

## Quick Start

### 1. Clone & install

```bash
git clone https://github.com/doomsday616/opencode-github-sync.git
cd opencode-github-sync

# Copy scripts
cp scripts/*.js ~/.config/opencode/scripts/          # macOS/Linux
# Copy-Item scripts\*.js "$HOME\.config\opencode\scripts\"  # Windows

# Install wrappers
cp wrappers/mac/* ~/.local/bin/ && chmod +x ~/.local/bin/opencode-*     # macOS/Linux
# Copy-Item wrappers\windows\*.cmd "$HOME\.local\bin\"                   # Windows
```

### 2. Set your remote

```bash
# macOS/Linux — add to ~/.zshrc or ~/.bashrc
export SYNC_REMOTE_URL="https://github.com/YOUR_USER/YOUR_PRIVATE_REPO.git"

# Windows — run once in PowerShell
# [System.Environment]::SetEnvironmentVariable("SYNC_REMOTE_URL", "https://github.com/YOUR_USER/YOUR_PRIVATE_REPO.git", "User")
```

### 3. Sync!

```bash
opencode-push          # Push — choose config / sessions / both
opencode-pull          # Pull — choose config / sessions / both
opencode-push-force    # Force push on conflict
opencode-pull-force    # Force pull (discard local)
```

## Prerequisites

- **Node.js** v18+
- **Git** + [Git LFS](https://git-lfs.github.com/)
- **A private GitHub repository** (create one, keep it empty)
- **SQLite3 CLI** — for session sync (database backup & integrity checks)

## Important Notes

- **Session sync must run outside OpenCode** — terminates running processes to safely copy SQLite db
- **Config sync can run inside OpenCode** — restart your session afterward
- Git repo auto-initializes on first push/pull
- `.gitignore` and `.gitattributes` are auto-generated

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SYNC_REMOTE_URL` | **Yes** | Your private GitHub repo URL |
| `SYNC_CONFIG_ROOT` | No | Override config dir (default: `~/.config/opencode`) |
| `SYNC_DATA_ROOT` | No | Override data dir (default: `~/.local/share/opencode`) |
| `SYNC_STATE_ROOT` | No | Override state dir (default: `~/.local/state/opencode`) |
| `SYNC_AGENTS_ROOT` | No | Override agents dir (default: `~/.agents/skills`) |
| `SYNC_SKIP_LFS` | No | Set to `1` to skip Git LFS |

## Project Structure

```
opencode-github-sync/
├── scripts/
│   ├── opencode-sync-core.js    # Entry point — interactive chooser
│   ├── sync-config.js           # Config + state sync logic (~710 lines)
│   └── sync-sessions.js         # Session + db sync logic (~890 lines)
├── wrappers/
│   ├── mac/                     # Shell wrappers (chmod +x)
│   └── windows/                 # .cmd wrappers
├── README.md
├── README.zh-CN.md
└── LICENSE
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=doomsday616/opencode-github-sync&type=Date&v=2)](https://star-history.com/#doomsday616/opencode-github-sync&Date)

## License

[MIT](./LICENSE)

---

<p align="center">
  If this tool saves you time, a ⭐ would be appreciated!
</p>
