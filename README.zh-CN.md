# opencode-github-sync

[English](./README.md)

通过私有 GitHub 仓库跨设备同步 [OpenCode](https://opencode.ai) 配置和会话数据。

将四个本地目录合并到一个 git 仓库：

| 本地目录 | 仓库路径 | 内容 |
|---|---|---|
| `~/.config/opencode/` | 仓库根目录 | 配置、技能、命令、MCP 设置 |
| `~/.local/share/opencode/` | `_data/` | 认证、同步状态、SQLite 数据库 |
| `~/.local/state/opencode/` | `_state/` | 使用频率、KV 存储、模型缓存 |
| `~/.agents/skills/` | `_agents/` | Skills CLI 全局安装 + lock 文件 |

## 功能特点

- **配置同步** — 跨设备推送/拉取配置文件、技能和状态
- **会话同步** — 推送/拉取 SQLite 数据库、存储和工具输出（在 OpenCode 外运行以避免数据库损坏）
- **自动暂存** — 拉取时自动暂存本地变更
- **强制模式** — `--force` 在冲突时覆盖
- **Git LFS** — 大型二进制文件（SQLite 数据库）通过 Git LFS 追踪
- **Migration 自动修复** — 拉取较旧数据库时自动恢复迁移记录
- **跨平台** — macOS 和 Windows (PowerShell 7)

## 前置条件

- **Node.js** (v18+)
- **Git** + [Git LFS](https://git-lfs.github.com/)
- **一个私有 GitHub 仓库** 用于存储同步数据
- **SQLite3 CLI**（会话同步需要 — 数据库备份和完整性检查）

## 安装

### 1. 克隆此仓库

```bash
git clone https://github.com/doomsday616/opencode-github-sync.git
```

### 2. 复制脚本到 OpenCode 配置目录

```bash
# macOS / Linux
cp opencode-github-sync/scripts/*.js ~/.config/opencode/scripts/

# Windows (PowerShell)
Copy-Item opencode-github-sync\scripts\*.js "$HOME\.config\opencode\scripts\"
```

### 3. 安装 wrapper 命令

**macOS / Linux:**
```bash
cp opencode-github-sync/wrappers/mac/* ~/.local/bin/
chmod +x ~/.local/bin/opencode-{pull,push,pull-force,push-force}
```

**Windows:**
```powershell
Copy-Item opencode-github-sync\wrappers\windows\*.cmd "$HOME\.local\bin\"
# 确保 ~/.local/bin 在 PATH 中
```

### 4. 设置远端 URL

将 `SYNC_REMOTE_URL` 环境变量设为你的私有 GitHub 仓库：

**macOS / Linux**（添加到 `~/.zshrc` 或 `~/.bashrc`）：
```bash
export SYNC_REMOTE_URL="https://github.com/YOUR_USER/YOUR_REPO.git"
```

**Windows**（PowerShell profile 或系统环境变量）：
```powershell
[System.Environment]::SetEnvironmentVariable("SYNC_REMOTE_URL", "https://github.com/YOUR_USER/YOUR_REPO.git", "User")
```

## 使用方法

### 交互模式

```bash
opencode-pull          # 拉取 — 选择配置/会话/全部
opencode-push          # 推送 — 选择配置/会话/全部
```

### 强制模式

```bash
opencode-pull-force    # 强制拉取（丢弃本地变更）
opencode-push-force    # 强制推送（冲突时覆盖远端）
```

### 直接调用脚本

```bash
node ~/.config/opencode/scripts/opencode-sync-core.js pull
node ~/.config/opencode/scripts/opencode-sync-core.js push --force
node ~/.config/opencode/scripts/opencode-sync-core.js status
```

## 注意事项

- **会话同步必须在 OpenCode 外运行** — 脚本会终止运行中的 OpenCode 进程以安全复制 SQLite 数据库
- **配置同步可以在 OpenCode 内运行** — 但之后需要重启会话使变更生效
- Git 仓库会在首次 push/pull 时自动初始化
- `.gitignore` 和 `.gitattributes` 会在同步仓库中自动生成

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `SYNC_REMOTE_URL` | **是** | GitHub 仓库 URL（例如 `https://github.com/user/repo.git`） |
| `SYNC_CONFIG_ROOT` | 否 | 覆盖配置目录（默认 `~/.config/opencode`） |
| `SYNC_DATA_ROOT` | 否 | 覆盖数据目录（默认 `~/.local/share/opencode`） |
| `SYNC_STATE_ROOT` | 否 | 覆盖状态目录（默认 `~/.local/state/opencode`） |
| `SYNC_AGENTS_ROOT` | 否 | 覆盖 agents/skills 目录（默认 `~/.agents/skills`） |
| `SYNC_SKIP_LFS` | 否 | 设为 `1` 跳过 Git LFS 设置 |

## 许可证

[MIT](./LICENSE)
