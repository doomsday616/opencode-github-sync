# 更新日志

[English](./CHANGELOG.md)

## 3.1.1

### 修复
- 推送时如果先合并了其他机器的提交，现在会把合并后的结果写回本机的真实目录（`~/.agents/skills`、state、data、额外路径）。以前这些新文件只进了仓库，之后的拉取发现没有新提交就跳过写回，下一次推送又把本机过时的目录打包上去，结果把别的机器刚装的 skill 删掉了。本机没有改动的推送现在会直接快进，并用同样的方式写回。
- 最近一次写回的提交记录在 `.git/info/opencode-sync-stage-out`。如果 HEAD 已经越过这个记录（例如推送在合并之后中断），下一次推送或拉取会先把仓库写回本机，再做其他事，这段差异不会再被当成删除推送出去。
- `extraPaths` 里的文件在本机不存在时，不再删除仓库里的共享副本，而是跳过并提示，其他机器照常接收。
- 写回目录类型的 `extraPaths` 时，不再删除仓库副本里没有的本机文件，同步配置旁边的工具运行文件在拉取后能保留下来。`--force` 仍然会做成完全一致的副本。文件类型的条目仍然只替换那一个文件。

## 3.1.0

### 新增
- **支持 OpenCode 2。** 同一个包现在在 OpenCode 1.x 和 2.x 上都能加载。感谢 @vitaly74（#6）。原理如下：
  - 默认导出是一个同时满足两种加载方式的对象。OpenCode 2 找的是 `{ id, setup }`：`setup(ctx)` 通过 `ctx.tool.transform` 注册 `opencode_sync` 工具，通过 `ctx.event.subscribe` 监听 `session.idle` 以支持可选的空闲推送，并在启动时拉取一次。OpenCode 1.x（1.3.4 及以上）看到的是同一个对象上的 `id` 和 `server()`，只调用一次 `server()`，所以插件只注册一次，不会重复。
  - 不依赖 `@opencode/plugin`，V2 的上下文按结构直接使用。
  - **配置写法。** OpenCode 1.x 只读 `"plugin"`，遇到 `"plugins"` 会直接丢掉且不报错；OpenCode 2 读自己的新写法 `"plugins"`，同时也认旧的 `"plugin"`。所以 `"plugin": ["opencode-github-sync"]` 是两个版本都能用的唯一写法，README 也推荐这样写。只用 2.x 的话可以写 `"plugins"`，但不要两个键里都写这个插件，2.x 会把两个列表都加载一遍。
  - 清理插件缓存时同时读取两个键，有的机器在 1.x、有的在 2.x 时，两个版本需要的插件都不会被误删。
  - OpenCode 1.0–1.3.3 会把每个导出都当函数调用，新的对象形式默认导出满足不了，这些版本请继续使用 3.0.1。

### 修复
- 导入会话不再连带删除其他会话。`INSERT OR REPLACE` 会先删掉冲突的行再插入，替换共享的 project 行时会通过 `ON DELETE CASCADE` 把之前导入的会话全部删掉。现在改用真正的 `INSERT ... ON CONFLICT DO UPDATE`，从不删除行，并且按行保留 `time_updated` 较新的一方。由 @logser13 报告并附上验证过的修法，@aquelejota 补充了连带删除的分析（#2）。
- 合成的 `global` 项目属于每台机器自己，不再导出；导入带有它的旧分片时，也不会覆盖本机的那一行。由 @logser13 报告，@aquelejota 确认（#4）。
- 会话分片导出现在是确定的：没有变化的会话生成的分片逐字节相同，不会在每次推送时都显示为改动。由 @logser13 报告（#3），@aquelejota 修复（#5）。
- 会话测试现在真的会在 vitest 下运行。以前 `node:sqlite` 在那里加载失败，每个会话测试都提前返回。由 @aquelejota 发现并修复（#5）。
- 清理插件缓存时同时读取 `plugin` 和 `plugins` 两个键，并识别 `[spec, options]` 元组和 `{ package }` 对象，无论用哪种写法列出的插件都不会再被误删缓存。这是对 @vitaly74 #6 的补充修改。

### 变更
- OpenCode 1.x 的最低支持版本变为 1.3.4。OpenCode 1.0–1.3.3 无法加载此版本，请继续使用 3.0.1。

### Contributors
- @vitaly74 — OpenCode 2 plugin entrypoint (#6)
- @aquelejota — deterministic shard export and working session tests (#5), analysis of #2, #3 and #4
- @logser13 — reported #2, #3 and #4 with reproductions and tested fixes

## 3.0.1

### 修复
- 在使用本机覆盖的机器上，`status` 不再把配置文件报告为未提交的改动。启用覆盖后，磁盘上的文件本来就应该和提交的版本不同，所以单纯的 `git status` 会永远提示已修改，用户无法消除。现在会先减去覆盖再比较，只有真正的编辑才算改动。
- 按模式解析 `git status --porcelain` 的输出，而不是按固定列位置。以前输出在解析前被裁掉了首部空白，未暂存条目的第一列丢失，后面的字段整体错位，得到的文件名被悄悄截断。

## 3.0.0

完全重写。之前的版本是一组套着 shell 外壳的 Node 脚本；这一版是带两个入口和完整测试的类型化库。

### 新增
- **OpenCode 插件。** 启动时拉取，可选在空闲时推送，并提供 `opencode_sync` 工具。命令行工具依然保留，因为插件无法修复让插件本身加载不了的配置。
- **本机覆盖。** `opencode-sync.overrides.jsonc` 在每次拉取后深度合并进配置，在每次推送前再减去，被覆盖的键在两个方向上都不会被同步。
- **按需同步会话。** 会话逐个导出为 gzip 压缩的 JSON 分片，可按时间范围、包含列表、项目目录和单个会话大小上限筛选。导入是事务性的插入或更新，`time_updated` 较新的一方胜出。
- 通过 GitHub CLI 一条命令完成设置：`opencode-sync init` / `link`。
- 推送和拉取支持 `--dry-run`。
- 用 `extraPaths` 同步任意额外文件。
- 在 Linux、macOS、Windows 上用 Node 20/22/24 做跨平台持续集成。

### 变更
- 用 TypeScript 重写，以 `opencode-github-sync` 发布到 npm。
- 新的终端界面，颜色在管道、`NO_COLOR` 和非真彩色终端下都能正确降级。
- 提交信息使用稳定的化名而不是真实主机名，公司资产编号永远不会进入仓库。
- 工作区换行符固定为 LF；单靠 `text=auto` 会在 Windows 上把 skill 里的 shell 脚本改成 CRLF。
- 凭据同步改为需要主动开启，并且在公开仓库上拒绝开启。

### 移除
- 整库会话同步和 Git LFS 依赖。`opencode.db` 超过 1 GB 后就无法再提交，而且在写前日志还在写入时复制，有可能拷到不完整的数据。
- shell 和 `.cmd` 包装脚本，改用真正的 `bin` 入口。

### 修复
- 推送后会回读远程分支来确认；`git push` 有可能返回成功但远程并没有更新。
- 拒绝跟随符号链接和 Windows 目录联接。
- 文件和目录的替换都是原子操作，同步中途被打断不会留下写了一半的配置。
- 删除 skill 安装后遗留的嵌套 `.git` 目录，skill 内容会作为普通文件提交，而不是无法使用的子模块链接。
- 跨进程锁防止插件、命令行和多个 OpenCode 窗口同时同步。
