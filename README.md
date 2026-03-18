# opencode-github-sync

[中文文档](./README.zh-CN.md)

Cross-device configuration and session sync for [OpenCode](https://opencode.ai) via a private GitHub repository.

Syncs four directories into one git repo:

| Local Directory | Repo Path | Contents |
|---|---|---|
| `~/.config/opencode/` | repo root | Config, skills, commands, MCP settings |
| `~/.local/share/opencode/` | `_data/` | Auth, sync-state, SQLite database |
| `~/.local/state/opencode/` | `_state/` | Frecency, KV store, model cache |
| `~/.agents/skills/` | `_agents/` | Skills CLI global installs + lock file |

## Features

- **Config sync** — push/pull config files, skills, and state across machines
- **Session sync** — push/pull SQLite database, storage, and tool output (runs outside OpenCode to avoid corruption)
- **Auto-stash** — local changes are automatically stashed during pull
- **Force mode** — `--force` to overwrite on conflict
- **Git LFS** — large binary files (SQLite db) tracked via Git LFS
- **Migration auto-repair** — automatically restores migration records when pulling an older database
- **Cross-platform** — macOS and Windows (PowerShell 7)

## Prerequisites

- **Node.js** (v18+)
- **Git** with [Git LFS](https://git-lfs.github.com/) installed
- **A private GitHub repository** for storing your sync data
- **SQLite3 CLI** (for session sync — database backup and integrity checks)

## Installation

### 1. Clone this repo

```bash
git clone https://github.com/doomsday616/opencode-github-sync.git
```

### 2. Copy scripts to OpenCode config directory

```bash
# macOS / Linux
cp opencode-github-sync/scripts/*.js ~/.config/opencode/scripts/

# Windows (PowerShell)
Copy-Item opencode-github-sync\scripts\*.js "$HOME\.config\opencode\scripts\"
```

### 3. Install wrapper commands

**macOS / Linux:**
```bash
cp opencode-github-sync/wrappers/mac/* ~/.local/bin/
chmod +x ~/.local/bin/opencode-{pull,push,pull-force,push-force}
```

**Windows:**
```powershell
Copy-Item opencode-github-sync\wrappers\windows\*.cmd "$HOME\.local\bin\"
# Ensure ~/.local/bin is in your PATH
```

### 4. Set the remote URL

Set the `SYNC_REMOTE_URL` environment variable to your private GitHub repo:

**macOS / Linux** (add to `~/.zshrc` or `~/.bashrc`):
```bash
export SYNC_REMOTE_URL="https://github.com/YOUR_USER/YOUR_REPO.git"
```

**Windows** (PowerShell profile or system environment):
```powershell
[System.Environment]::SetEnvironmentVariable("SYNC_REMOTE_URL", "https://github.com/YOUR_USER/YOUR_REPO.git", "User")
```

## Usage

### Interactive mode

```bash
opencode-pull          # Pull — choose config / sessions / both
opencode-push          # Push — choose config / sessions / both
```

### Force mode

```bash
opencode-pull-force    # Force pull (discard local changes)
opencode-push-force    # Force push (overwrite remote on conflict)
```

### Direct script usage

```bash
node ~/.config/opencode/scripts/opencode-sync-core.js pull
node ~/.config/opencode/scripts/opencode-sync-core.js push --force
node ~/.config/opencode/scripts/opencode-sync-core.js status
```

## Important Notes

- **Session sync must run outside OpenCode** — the script terminates running OpenCode processes to safely copy the SQLite database
- **Config sync can run inside OpenCode** — but restart your session afterward for changes to take effect
- The git repo is initialized automatically on first push/pull
- `.gitignore` and `.gitattributes` are auto-generated in the sync repo

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SYNC_REMOTE_URL` | **Yes** | GitHub repo URL (e.g. `https://github.com/user/repo.git`) |
| `SYNC_CONFIG_ROOT` | No | Override config directory (default: `~/.config/opencode`) |
| `SYNC_DATA_ROOT` | No | Override data directory (default: `~/.local/share/opencode`) |
| `SYNC_STATE_ROOT` | No | Override state directory (default: `~/.local/state/opencode`) |
| `SYNC_AGENTS_ROOT` | No | Override agents/skills directory (default: `~/.agents/skills`) |
| `SYNC_SKIP_LFS` | No | Set to `1` to skip Git LFS setup |

## License

[MIT](./LICENSE)
