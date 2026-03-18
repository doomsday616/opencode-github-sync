<p align="center">
  <img src="docs/banner.svg" alt="opencode-github-sync" width="700"/>
</p>

<p align="center">
  <strong>跨设备同步你的 OpenCode 一切配置</strong>
</p>

<p align="center">
  简体中文 ｜ <a href="./README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/doomsday616/opencode-github-sync/releases"><img src="https://img.shields.io/github/v/release/doomsday616/opencode-github-sync?style=flat-square&color=38bdf8" alt="Release"/></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/doomsday616/opencode-github-sync?style=flat-square&color=818cf8" alt="License"/></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-34d399?style=flat-square" alt="Platform"/>
  <img src="https://img.shields.io/badge/node-%3E%3D18-fbbf24?style=flat-square" alt="Node"/>
</p>

---

## 痛点

你在多台机器上用 [OpenCode](https://opencode.ai) — MacBook 在外面用，Windows 台式机在家用。配置、技能、MCP 设置、会话记录都散落在不同设备上。

## 方案

**opencode-github-sync** 把四个本地目录合并到一个私有 GitHub 仓库，通过简单的 push/pull 命令同步。

```
~/.config/opencode/       →  仓库根目录     (配置、技能、命令、MCP)
~/.local/share/opencode/  →  _data/         (认证、同步状态、SQLite 数据库)
~/.local/state/opencode/  →  _state/        (使用频率、KV 存储、模型缓存)
~/.agents/skills/         →  _agents/       (Skills CLI 安装 + lock 文件)
```

## 工作原理

<p align="center">
  <img src="docs/architecture.svg" alt="架构图" width="700"/>
</p>

## 功能特点

| 功能 | 说明 |
|---|---|
| 🔄 **配置同步** | 跨设备推送/拉取配置文件、技能和状态 |
| 💾 **会话同步** | 通过 `.backup` 安全备份 SQLite — 在 OpenCode 外运行避免损坏 |
| 📦 **自动暂存** | 拉取时自动暂存本地变更 |
| 💪 **强制模式** | `--force` 在冲突时覆盖（推送或拉取） |
| 🗃️ **Git LFS** | 大型二进制文件（SQLite 数据库）通过 Git LFS 追踪 |
| 🔧 **Migration 修复** | 拉取较旧数据库时自动恢复迁移记录 |
| 🖥️ **跨平台** | macOS (zsh) + Windows (PowerShell 7) |

## 不会？让 OpenCode 帮你搞定

如果你不熟悉 Git、GitHub CLI 或环境变量这些东西 —— 没关系，把下面这段话直接粘贴到 OpenCode 里，让它帮你搞定一切：

```
我想在多台电脑之间同步 OpenCode 的配置和会话记录。帮我从零开始搞定所有前置准备：

1. 检查我电脑上有没有装 Git、Git LFS、Node.js、SQLite3，没装的帮我装上
2. 检查 gh（GitHub CLI）装没装，没有就帮我装，然后帮我登录 GitHub
3. 帮我在 GitHub 上创建一个私有仓库用来存同步数据
4. 把 opencode-github-sync 项目克隆下来，脚本和命令都帮我安装到正确的位置
5. 帮我设好 SYNC_REMOTE_URL 环境变量
6. 跑一次 opencode-push，只选配置同步，测试能不能正常工作

注意：会话同步需要在 OpenCode 外面的终端里手动执行（因为要关闭 OpenCode 才能安全复制数据库），
帮我准备好命令，我自己跑就行。
```

## 快速开始

### 1. 克隆 & 安装

```bash
git clone https://github.com/doomsday616/opencode-github-sync.git
cd opencode-github-sync

# 复制脚本
cp scripts/*.js ~/.config/opencode/scripts/          # macOS/Linux
# Copy-Item scripts\*.js "$HOME\.config\opencode\scripts\"  # Windows

# 安装 wrapper 命令
cp wrappers/mac/* ~/.local/bin/ && chmod +x ~/.local/bin/opencode-*     # macOS/Linux
# Copy-Item wrappers\windows\*.cmd "$HOME\.local\bin\"                   # Windows
```

### 2. 设置远端仓库

```bash
# macOS/Linux — 添加到 ~/.zshrc 或 ~/.bashrc
export SYNC_REMOTE_URL="https://github.com/你的用户名/你的私有仓库.git"

# Windows — 在 PowerShell 中运行一次
# [System.Environment]::SetEnvironmentVariable("SYNC_REMOTE_URL", "https://github.com/你的用户名/你的私有仓库.git", "User")
```

### 3. 开始同步！

```bash
opencode-push          # 推送 — 选择配置/会话/全部
opencode-pull          # 拉取 — 选择配置/会话/全部
opencode-push-force    # 冲突时强制推送
opencode-pull-force    # 强制拉取（丢弃本地变更）
```

## 前置条件

- **Node.js** v18+
- **Git** + [Git LFS](https://git-lfs.github.com/)
- **一个私有 GitHub 仓库**（创建一个空仓库即可）
- **SQLite3 CLI** — 会话同步需要（数据库备份和完整性检查）

## 注意事项

- **会话同步必须在 OpenCode 外运行** — 会终止运行中的进程以安全复制 SQLite 数据库
- **配置同步可以在 OpenCode 内运行** — 但之后需要重启会话
- Git 仓库会在首次 push/pull 时自动初始化
- `.gitignore` 和 `.gitattributes` 会自动生成

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `SYNC_REMOTE_URL` | **是** | 你的私有 GitHub 仓库 URL |
| `SYNC_CONFIG_ROOT` | 否 | 覆盖配置目录（默认 `~/.config/opencode`） |
| `SYNC_DATA_ROOT` | 否 | 覆盖数据目录（默认 `~/.local/share/opencode`） |
| `SYNC_STATE_ROOT` | 否 | 覆盖状态目录（默认 `~/.local/state/opencode`） |
| `SYNC_AGENTS_ROOT` | 否 | 覆盖 agents 目录（默认 `~/.agents/skills`） |
| `SYNC_SKIP_LFS` | 否 | 设为 `1` 跳过 Git LFS |

## 项目结构

```
opencode-github-sync/
├── scripts/
│   ├── opencode-sync-core.js    # 入口 — 交互式选择器
│   ├── sync-config.js           # 配置 + 状态同步逻辑 (~710 行)
│   └── sync-sessions.js         # 会话 + 数据库同步逻辑 (~890 行)
├── wrappers/
│   ├── mac/                     # Shell wrapper (chmod +x)
│   └── windows/                 # .cmd wrapper
├── README.md
├── README.zh-CN.md
└── LICENSE
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=doomsday616/opencode-github-sync&type=Date&v=2)](https://star-history.com/#doomsday616/opencode-github-sync&Date)

## 许可证

[MIT](./LICENSE)

---

<p align="center">
  如果这个工具帮到了你，欢迎给个 ⭐！
</p>
