<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/zh-CN/01-hero.png" alt="opencode-github-sync：一份配置，每台电脑都一样" width="880">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/opencode-github-sync"><img alt="npm" src="https://img.shields.io/npm/v/opencode-github-sync?style=flat-square&color=7aa2f7&labelColor=1a1e2b"></a>
  <a href="https://github.com/doomsday616/opencode-github-sync/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/doomsday616/opencode-github-sync/ci.yml?style=flat-square&color=9ece6a&labelColor=1a1e2b&label=ci"></a>
  <a href="https://github.com/doomsday616/opencode-github-sync/blob/main/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-bb9af7?style=flat-square&labelColor=1a1e2b"></a>
  <img alt="platform" src="https://img.shields.io/badge/macOS%20·%20Windows%20·%20Linux-9ece6a?style=flat-square&labelColor=1a1e2b&label=runs%20on">
</p>

<p align="center">
  <a href="https://github.com/doomsday616/opencode-github-sync/blob/main/README.md">English</a>
  &nbsp;·&nbsp;
  <a href="#安装">安装</a>
  &nbsp;·&nbsp;
  <a href="#选择使用方式">使用方式</a>
  &nbsp;·&nbsp;
  <a href="#自动同步是怎么工作的">自动同步</a>
  &nbsp;·&nbsp;
  <a href="#命令速查">命令</a>
  &nbsp;·&nbsp;
  <a href="#常见问题">常见问题</a>
</p>

---

你在好几台电脑上用 OpenCode，配置、智能体、自定义命令、技能和 MCP 服务器却总是停留在"上次改的那台"上。

**opencode-github-sync** 借助一个 GitHub 私有仓库，让每台电脑用上同一套配置。可以手动同步，也可以让一台电脑在后台自己同步。

## 安装

**macOS / Linux**

```bash
curl -fsSL https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.sh | sh
```

**Windows**（PowerShell 5.1 或 7 都可以）

```powershell
irm https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.ps1 | iex
```

安装脚本会先检查 Node.js 18+ 和 git。缺了哪个，就把安装命令列出来，问过你才执行。之后运行 `npm install -g opencode-github-sync@latest`，并打开菜单。

已经装了 Node.js？直接 `npm install -g opencode-github-sync`，再运行 `opencode-sync`，效果一样。

### 一行命令配好一台电脑

带上参数就能跳过所有提问，适合给新电脑批量部署：

```bash
curl -fsSL https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.sh | sh -s -- --mode auto --repo 你的用户名/my-opencode-config
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.ps1))) -Mode auto -Repo 你的用户名/my-opencode-config
```

| 参数 | 作用 |
| --- | --- |
| `--mode cli` / `-Mode cli` | 只装命令 |
| `--mode link` | 关联 `--repo` 并同步一次 |
| `--mode auto` | 关联、同步一次，并开启自动同步 |
| `--repo 用户名/仓库名` | 要用的仓库（也可以是 git 地址）；不存在时会新建为私有仓库 |
| `--interval N` | 每 N 分钟自动同步一次（最少 2，默认 5） |
| `--lang en` / `zh-CN` | 界面语言 |
| `--proxy 地址` | npm 和 git 用的代理，安装时和之后同步时都会用 |
| `--yes` | 缺 Node.js 或 git 时不再询问，直接安装 |

如果仓库里已经有内容、本机也有自己的文件，设置时以仓库为准，被替换的本机文件会存进[恢复目录](#安全机制)。

---

## 选择使用方式

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/zh-CN/03-setup-choice.png" alt="只装命令，或者主力设备加自动同步" width="760">
</p>

第一次运行 `opencode-sync` 时，它会问你这台电脑打算怎么用。

| | 只装命令 | 主力设备 + 自动同步 |
| --- | --- | --- |
| 怎么同步 | 你自己运行 `opencode-sync push` / `pull`，或者插件在 OpenCode 启动时拉取 | 操作系统每隔几分钟同步一次，OpenCode 没开也照样同步 |
| 适合 | 偶尔用一下的电脑、共用或受管控的电脑 | 每天干活用的电脑 |
| 后台任务 | 无 | 任务计划程序、launchd 或 systemd 定时器 |

之后随时可以在**自动同步**菜单里改。自动同步按电脑单独开启：在这台打开，不会影响其他任何一台。

---

## 菜单一览

不带参数运行 `opencode-sync`：

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/menu.zh-CN.svg" alt="opencode-sync 菜单" width="760">
</p>

方向键或括号里的快捷键选择，空格勾选，回车确认，Esc 返回。如果输入不是终端（管道、脚本、CI），每个问题都会变成编号提问，所以也能用文件驱动整个菜单。

| 菜单项 | 能做什么 |
| --- | --- |
| **立即同步** | 推送并接收、只接收、只推送，或者先预览 |
| **同步哪些内容** | 勾选主配置、指令文件、智能体、自定义命令、插件、技能、登录凭据、会话；设置会话范围；添加额外路径 |
| **自动同步** | 开关；选 5/10/15/30/60 分钟或自定义间隔；暂停；注销后也运行（Windows）；桌面通知 |
| **更新** | 检查 npm 上的新版本、立即升级、每天自动更新 |
| **本机专属设置** | 用编辑器打开专属设置文件，查看它改了哪些值 |
| **诊断** | git、node、gh、仓库访问、定时任务、最近的日志；导出排障包 |
| **危险操作** | 让本机和仓库完全一致，或者反过来（要输入 `overwrite` 确认） |
| **卸载** | 删除定时任务，可选解除关联、删除命令。你的配置文件永远不会被删 |
| **网络代理** | git、gh、npm 用的代理，只对 opencode-sync 生效 |
| **从历史版本恢复文件** | 选文件、选版本、恢复 |
| **设备列表** | 哪些电脑同步过、上次是什么时候，还能给本机改名 |
| **大改动保护** | 设置推送多大的改动时要先停下来问你 |
| **界面语言** | English、简体中文或自动 |

以前版本的所有命令都还在，照样可以写进脚本。

---

## 同步哪些内容

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/zh-CN/02-how-it-works.png" alt="每台电脑都通过同一个私有仓库推送和拉取" width="760">
</p>

`~/.config/opencode` 文件夹本身就是仓库的工作目录，其他位置的内容会镜像到仓库里的子文件夹。

| 本机位置 | 仓库里的位置 | 内容 |
| --- | --- | --- |
| `~/.config/opencode/` | 根目录 | 配置、智能体、自定义命令、插件、主题、指令文件 |
| `~/.local/share/opencode/` | `_data/` | 项目信息；开启后还有登录凭据 |
| `~/.local/state/opencode/` | `_state/` | 模型缓存、最近文件、输入历史 |
| `~/.agents/skills/` | `_agents/` | 用 `skills` 命令安装的技能 |
| 选中的会话 | `_sessions/` | 每个会话一个压缩小文件 |
| 额外路径 | `_extra/` | 你自己加的任何东西 |

每一项都能在**同步哪些内容**里关掉。关掉的项双向都只留在本机：你的改动不会推上去，别的电脑的版本也不会覆盖你的。

**永远不同步：** `opencode.db` 数据库、工具输出、快照、日志、`node_modules` 之类的生成目录，以及 opencode-sync 自己的设置文件和专属设置文件。

---

## 自动同步是怎么工作的

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/zh-CN/04-autosync-timeline.png" alt="多台电脑错峰同步，忙碌时等待，出错时退避" width="760">
</p>

开启后，操作系统每隔几分钟、以及登录时（Windows 上还包括解锁和远程桌面重连时）运行一次 `opencode-sync autosync run`。每次只做一个判断：

1. **现在安静吗？** 只要配置或技能文件夹里有文件在最近一分钟内改过，就说明还有东西在写。这时推送可能会把写了一半的文件发出去，所以先等。
2. **至少能接收吗？** 忙的时候它仍然会接收别的电脑的改动，但前提是本机没有自己待推送的东西；否则留到下一次。
3. **推送并接收。** 你的改动上去，别人的改动下来，一步完成。

保证安全的几条规则：

- **多台电脑错峰。** 每台电脑会根据自己的名字固定等几秒，几台电脑排在同一个时刻也不会每次都撞车。万一还是被别人抢先，这台会把新提交合进来再试一次，不算出错。
- **会退避，但永不放弃。** 连续失败三次（通常是没网）后，改成 30 分钟、再到每小时试一次。一旦成功就恢复正常节奏。
- **只打扰你两次。** 开始退避时弹一次通知，恢复时再弹一次。平时同步不弹。
- **绝不同时跑两个。** 定时任务、命令行、菜单和每个 OpenCode 窗口共用一把锁，有一个在跑，其他的就跳过。
- **绝不替你确认大改动。** 触发[大改动保护](#安全机制)的推送会被拦下，并通知你。

| 平台 | 调度方式 | 说明 |
| --- | --- | --- |
| Windows | 任务计划程序 | 后台运行不弹窗。想在注销后也运行，先在菜单里打开这一项，再从管理员终端安装 |
| macOS | launchd | `~/Library/LaunchAgents/com.opencode-github-sync.autosync.plist` |
| Linux | systemd 用户定时器 | 不可用时退回 crontab。服务器上要运行 `loginctl enable-linger`，注销后才会继续跑 |

`opencode-sync autosync status` 会显示上次运行、最后的错误和下次尝试的时间。开启自动同步后，OpenCode 插件不再在空闲时推送，免得两边抢；启动时照常拉取。

---

## 本机专属设置

有些设置只属于一台电脑：公司代理、本地工具路径、只有这台才有的 MCP 服务器。把它们写进 `~/.config/opencode/opencode-sync.overrides.jsonc`，或者在菜单的**本机专属设置**里打开：

```jsonc
{
  "model": "github-copilot/claude-sonnet-4",
  "mcp": {
    "playwright": { "enabled": true }
  }
}
```

```
   仓库里的 opencode.jsonc      共享，会提交
 + overrides.jsonc              只属于本机，不提交
 ───────────────────────────    合并
 = 实际生效的 opencode.jsonc    OpenCode 读到的
```

对象按键逐个合并，数组和普通值直接替换，`null` 表示删掉这个键。每次推送前，专属设置里出现过的键都会还原成仓库里的值，所以这台电脑专用的值永远不会跑到别的电脑上。没有专属设置文件时，配置原样复制，连注释都不动。

---

## 会话同步

默认关闭。只在私有仓库里开启：对话内容是隐私。

```bash
opencode-sync sessions enable
opencode-sync sessions list
opencode-sync sessions include ses_065cad1caffeN3lf1RgLZno30   # 这个会话始终同步
opencode-sync sessions exclude ses_0ba19b4e7ffeMbSmWYi3Nj6xfZ  # 这个会话永不同步
```

会话不是靠提交整个数据库来同步的。真实的 OpenCode 数据库会涨到好几 GB，大部分是工具输出，git 也没法合并它。所以每个会话单独导出成一个压缩小文件：

- **体积小。** 只同步最近的会话（默认 7 天、最多 50 个），单个超过 5 MB 的会话直接跳过。
- **基本不冲突。** 两台电脑各自处理不同的会话，改的是不同的文件。同一个会话在两边都改了，保留较新的那份。
- **导入安全。** 导入在一个事务里完成，失败了数据库保持原样。

时间范围、数量和大小上限在**同步哪些内容 → 会话同步设置**里调。会话同步需要 Node.js 22.5 或更新版本。

---

## 安全机制

<p align="center">
  <img src="https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/docs/images/zh-CN/05-safety-net.png" alt="同步锁、原子替换、恢复目录、大改动保护" width="760">
</p>

- **原子替换。** 文件先写在目标旁边，再一次性换过去。同步到一半崩溃，也不会留下写了一半、导致 OpenCode 启动不了的配置。
- **推送后核实。** 推送完会回读远端确认。`git push` 有时报成功但远端根本没变，这一点会检查，不会想当然。
- **同一时间只跑一个。** 插件、命令行、菜单和定时任务共用一把锁。
- **大改动保护。** 一次推送新增超过 300 个文件、总量超过 10 MB，或有单个文件超过 2 MB，会先停下来问你。上限可调。`node_modules`、`.venv`、`venv`、`__pycache__`、`dist`、`.cache` 这类生成目录永远不会推送。
- **恢复目录。** 强制拉取、首次关联时以仓库为准、从历史恢复文件之前，即将被替换的文件会先复制到 `~/.local/share/opencode/opencode-sync-recovery/<时间>-<原因>/`。
- **登录凭据默认不同步**，仓库是公开的时候直接拒绝。
- **不泄露主机名。** 提交里用固定的代号（或你起的名字）标记电脑，不用真实主机名。
- **拒绝符号链接，不跟随**，同步不会顺着链接把别处的文件复制出去。

---

## OpenCode 插件

插件可装可不装。它会在 OpenCode 启动时拉取，可以在会话空闲时推送，还提供一个 `opencode_sync` 工具，直接说一句"同步一下"就行。

```jsonc
// ~/.config/opencode/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-github-sync"]
}
```

这种 `"plugin"` 写法在 OpenCode 1.x（1.3.4 及以上）和 OpenCode 2.x 上都能用：1.x 只认 `"plugin"`，2.x 除了自己的 `"plugins"` 之外也仍然接受 `"plugin"`。如果你只用 OpenCode 2，也可以改写在 `"plugins"` 里。不要两个键里都写上这个插件——OpenCode 2 会把两个列表里的条目都加载。

OpenCode 1.0–1.3.3 无法加载 3.1.0 及以后的版本，请在这些版本上继续使用 `opencode-github-sync@3.0.1`。

就算用了插件，也请保留命令行。插件修不了"导致插件加载不了"的那份配置，`opencode-sync pull --force` 可以。

---

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `opencode-sync` | 打开菜单（同 `opencode-sync menu`） |
| `opencode-sync init [名字]` | 用 `gh` 新建私有同步仓库 |
| `opencode-sync link <用户名/仓库名 或 地址>` | 使用已有仓库 |
| `opencode-sync setup --mode cli\|link\|auto` | 无交互设置，安装脚本用的就是它 |
| `opencode-sync push` | 推送本机的改动 |
| `opencode-sync pull` | 拉取共享配置 |
| `opencode-sync status` | 查看哪些已同步、哪些没有 |
| `opencode-sync autosync enable` / `disable` | 在本机开启或关闭自动同步 |
| `opencode-sync autosync install` / `uninstall` | 只注册或删除定时任务 |
| `opencode-sync autosync status` | 上次运行、最后的错误、下次尝试 |
| `opencode-sync autosync run` | 马上执行一次定时同步 |
| `opencode-sync autosync pause <小时数>\|tomorrow` / `resume` | 暂停或恢复 |
| `opencode-sync autosync reset` | 清零失败次数 |
| `opencode-sync sessions list\|enable\|disable` | 会话同步 |
| `opencode-sync sessions include\|exclude <id>` | 某个会话始终同步或永不同步 |
| `opencode-sync overrides` | 创建或找到专属设置文件 |
| `opencode-sync config` | 打印设置 |

| 参数 | 作用 |
| --- | --- |
| `--force` | 覆盖另一端（需要输入 `yes` 确认；加 `--yes` 跳过） |
| `--dry-run` | 只显示会改什么，不实际改 |
| `--allow-large` | 大改动保护反对时也照样推送 |
| `--lang en\|zh-CN` | 本次运行的界面语言 |

| 环境变量 | 作用 |
| --- | --- |
| `OPENCODE_SYNC_LANG` | 界面语言 |
| `OPENCODE_SYNC_HOST_ALIAS` | 提交里用的电脑名字 |
| `OPENCODE_SYNC_PROXY` | git、gh、npm 用的代理 |
| `OPENCODE_SYNC_VERBOSE=1` | 显示完整文件列表和错误堆栈 |
| `SYNC_REMOTE_URL` | 覆盖仓库地址 |
| `NO_COLOR` | 不输出颜色 |

### 设置文件

`~/.config/opencode/opencode-sync.jsonc` 只留在本机，永远不会提交。菜单会帮你改，所有键都可以省略。

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

## 常见问题

**我得走代理。** 给安装脚本加 `--proxy http://主机:端口`（Windows 上是 `-Proxy`）。安装时 npm 和 git 都会用它，之后同步也会继续用。随时可以在**网络代理**里改。

**`curl | sh` 怎么不问我问题？** 脚本本身是从管道传进来的，所以它改从终端读你的回答。如果根本没有终端（CI、Dockerfile），就没人可问了：加上 `--mode` 和 `--repo`；可能需要装 Node.js 或 git 的话再加 `--yes`。

**Windows 提示禁止运行脚本。** `irm ... | iex` 不是运行脚本文件，执行策略管不到它。如果你把 `install.ps1` 下载下来当文件运行，请用 `powershell -ExecutionPolicy Bypass -File install.ps1`。

**装完找不到 `opencode-sync`。** npm 把它装到了不在 `PATH` 里的文件夹。`npm prefix -g` 能看到是哪个文件夹，把它下面的 `bin`（Windows 上就是这个文件夹本身）加进 `PATH`。

**开了自动同步却没动静。** 运行 `opencode-sync autosync status`，看看是不是被暂停了、出错后在退避，还是因为文件还在变化而在等。菜单里的**诊断**可以看定时任务有没有注册上。

**拉取时和本地改动冲突了。** 你的改动保存在 git stash 里，恢复用的命令会直接打印出来。不会丢东西。

**提示"这台电脑有 N 个提交从没推送过"。** 这时拉取会把它们丢掉，所以先停下。运行 `opencode-sync push`，或者用 `pull --force` 放弃它们。

**认证失败。** 运行 `gh auth login -h github.com`。私有仓库需要 `repo` 权限。

**同步之后 OpenCode 启动不了了。** 命令行就是为这种时候准备的：

```bash
opencode-sync pull --force
```

被替换的文件会先存进恢复目录。

---

## 从 3.1.x 升级

```bash
npm install -g opencode-github-sync@latest
```

不需要别的操作：设置、专属设置和仓库都照常工作，自动同步在你打开之前一直是关的。如果你之前用自己的脚本定时同步，开启自动同步前先把它停掉，免得两边抢。如果你在插件里开了 `autoPushOnIdle`，在开启了自动同步的电脑上，由自动同步接替它。

---

## 开发

```bash
npm install
npm run check     # 代码检查、类型检查和测试
npm run build
```

测试直接在磁盘上的真实 git 仓库里跑，并模拟多台电脑，推送、拉取、变基、自动同步调度和菜单都端到端覆盖。真正的定时任务只会在用完即弃的 CI 机器上注册。

---

## Star 趋势

<a href="https://star-history.com/#doomsday616/opencode-github-sync&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=doomsday616/opencode-github-sync&type=Date&theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=doomsday616/opencode-github-sync&type=Date">
    <img alt="Star 趋势图" src="https://api.star-history.com/svg?repos=doomsday616/opencode-github-sync&type=Date" width="640">
  </picture>
</a>

---

## 许可证

[MIT](https://github.com/doomsday616/opencode-github-sync/blob/main/LICENSE)

<p align="center">
  <sub>如果它帮你省了时间，欢迎点个 ⭐。</sub>
</p>
