# Changelog

[简体中文](./CHANGELOG.zh-CN.md)

## 3.2.0

### Added
- **One-line installers.** `install.ps1` (Windows PowerShell 5.1 and PowerShell 7) and `install.sh` (macOS, Linux) check for Node.js 18+ and git, offer to install a missing one through winget, Homebrew or the system package manager (they ask first and never install silently), run `npm install -g opencode-github-sync@latest`, and open the menu. `--mode`, `--repo`, `--interval`, `--lang`, `--proxy` and `--yes` run the whole setup non-interactively. Under `curl | sh` questions are read from the terminal, and on Windows the menu runs as its own process so it gets the keyboard.
- **Interactive menu.** `opencode-sync` with no arguments (or `opencode-sync menu`) opens a menu with arrow keys, hotkeys and checkboxes, and falls back to numbered prompts whenever input is not a terminal. Every existing subcommand still works and stays scriptable. First run offers: install the command only, link a repository, or link and make this the primary device with autosync. When the machine and the repository differ, it shows the differences and lets you pick a side; the losing side's files go to a recovery folder.
- **English and Simplified Chinese** for every menu and command string, detected from `OPENCODE_SYNC_LANG`, `LC_ALL`/`LC_MESSAGES`/`LANG` or the system locale, and switchable with `--lang` or from the menu.
- **Autosync driven by the operating system.** `opencode-sync autosync install|uninstall|enable|disable|status|run|reset|pause|resume`. Task Scheduler on Windows (logon, unlock, remote connect and a repeating timer; hidden through `conhost --headless` or a UTF-16 VBScript launcher), launchd on macOS, a systemd user timer on Linux with a crontab fallback. Each run pushes only when the synced trees have been quiet for a settle period, and otherwise receives only when this machine has nothing of its own in flight. Machines are staggered so they do not collide, failures back off from 30 to 60 minutes without ever giving up, a lost push race is retried rather than counted, and a desktop notification appears only when backing off starts and when it recovers.
- **What to sync** as checkboxes: main config, instruction files, agents, commands, plugins, skills, credentials and sessions. A switched-off category stays local in both directions.
- **Large-change guard.** A push that adds more than 300 files, more than 10 MB, or any file over 2 MB waits for confirmation (thresholds are adjustable). Autosync never confirms: it records a failure and notifies. The first push into an empty repository carries the whole existing setup, so only the single-file limit applies there. Generated directories (`node_modules`, `.venv`, `venv`, `__pycache__`, `dist`, `.cache`) are never staged.
- **Restore a file from history**, with the replaced version kept in the recovery folder.
- **Device list** built from commit history, and renaming this machine.
- **Network proxy** for git, gh and npm, applied to child processes only.
- **Preview** of what a sync would change before running it.
- **Support bundle** export with tokens, passwords and URL credentials removed.
- **Update** menu: check npm, upgrade, and an optional daily auto-update run by the autosync job.

### Changed
- When autosync is on, the plugin no longer pushes on idle (it still pulls at startup), so it never races the scheduled job.
- Sync commits carry an `Opencode-Sync-Device` trailer naming the machine.
- `link` accepts any git URL or local path in addition to `owner/name`.
- A forced pull, and the first pull onto a machine that already has files, copy the files they replace into `opencode-sync-recovery` under the data directory first. This covers new folders, non-ASCII file names, and local skills and extra-path files that the forced pull removes or overwrites.

### Fixed
- A push that loses a race with another machine rebases and retries up to three times instead of failing. A protected branch or a declined hook is reported as a failure rather than retried.
- The first push from a machine whose config directory is not yet a repository now writes the remote's skills out before staging, so it can no longer publish every skill it lacks as a deletion.
- Git runs with `core.quotepath=off` and English messages, so non-ASCII file names count toward the large-change guard and a lost push race is recognised on a localized git.

### Contributors
- @vitaly74 — OpenCode 2 plugin entrypoint (#6, 3.1.0)
- @aquelejota — deterministic shard export and working session tests (#5), analysis of #2, #3 and #4 (3.1.0)
- @logser13 — reported #2, #3 and #4 with reproductions and tested fixes (3.1.x)

## 3.1.1

### Fixed
- A push that rebased onto other machines' commits now writes the merged result out to the real directories (`~/.agents/skills`, state, data, extra paths). Previously the new files landed only in the repository, a later pull saw nothing incoming and skipped the write-out, and the next push staged the stale local tree and deleted another machine's new skills. A push with nothing local now fast-forwards and writes out the same way.
- The commit last written out is recorded in `.git/info/opencode-sync-stage-out`. When HEAD has moved past it (for example a push that stopped after the rebase), the next push or pull writes the repository out before doing anything else, so the gap can no longer be published as deletions.
- An `extraPaths` source that does not exist on this machine no longer deletes the shared repository copy. It is skipped and reported; other machines keep receiving it.
- Writing out a directory `extraPaths` entry no longer deletes local files that are not in the repository copy, so a tool's runtime files beside its synced config survive a pull. `--force` still makes it an exact copy. File entries continue to replace only that file.

## 3.1.0

### Added
- **OpenCode 2 support.** One package now loads on both OpenCode 1.x and 2.x. Thanks @vitaly74 (#6). How it works:
  - The default export is a single object that satisfies both loaders. OpenCode 2 looks for `{ id, setup }`: `setup(ctx)` registers the `opencode_sync` tool through `ctx.tool.transform`, subscribes to `session.idle` through `ctx.event.subscribe` for the optional idle push, and runs the startup pull. OpenCode 1.x (1.3.4 and later) sees the same object's `id` and `server()` and calls `server()` once, so the plugin is registered exactly once.
  - No dependency on `@opencode/plugin`; the V2 context is used structurally.
  - **Config key.** OpenCode 1.x reads only `"plugin"` and silently drops `"plugins"`. OpenCode 2 reads its native `"plugins"` and still accepts the legacy `"plugin"`. So `"plugin": ["opencode-github-sync"]` is the one form that works on both, and it is what the README recommends. A 2.x-only setup may use `"plugins"`, but never list the plugin under both keys: 2.x loads both lists.
  - Plugin cache pruning reads both keys, so a mixed fleet where some machines are on 1.x and some on 2.x keeps every plugin either version needs.
  - OpenCode 1.0–1.3.3 iterate every export and call each as a function, which the new object default export cannot satisfy. Stay on 3.0.1 there.

### Fixed
- Session import no longer cascade-deletes sessions. `INSERT OR REPLACE` deletes the conflicting row before inserting, so replacing a shared project row cascaded through `ON DELETE CASCADE` and removed every session imported before it. It is replaced by a real `INSERT ... ON CONFLICT DO UPDATE` upsert that never deletes and keeps newer-`time_updated`-wins per row. Reported with a tested fix by @logser13, cascade analysis by @aquelejota (#2).
- The synthetic `global` project is machine-specific, so it is no longer exported, and importing an older shard that carries it never overwrites the local row. Reported by @logser13, confirmed by @aquelejota (#4).
- Session shard export is deterministic: an unchanged session produces a byte-identical shard, so it no longer shows up as a change on every push. Reported by @logser13 (#3), fixed by @aquelejota (#5).
- The session tests now actually run under vitest; previously `node:sqlite` failed to load there and every session test returned early. Found and fixed by @aquelejota (#5).
- Plugin cache pruning reads both the `plugin` and `plugins` keys and understands `[spec, options]` tuples and `{ package }` objects, so a plugin listed in either form is no longer pruned from the cache. Follow-up to @vitaly74's #6.

### Changed
- The minimum supported OpenCode 1.x is now 1.3.4. OpenCode 1.0–1.3.3 cannot load this release; stay on 3.0.1 there.

### Contributors
- @vitaly74 — OpenCode 2 plugin entrypoint (#6)
- @aquelejota — deterministic shard export and working session tests (#5), analysis of #2, #3 and #4
- @logser13 — reported #2, #3 and #4 with reproductions and tested fixes

## 3.0.1

### Fixed
- `status` no longer reports the config file as uncommitted work on machines that use per-machine overrides. The file on disk is *supposed* to differ from the committed version once overrides are in play, so plain `git status` flagged it as modified forever — a warning the user could never clear. The config is now compared with overrides subtracted, so only genuine edits count.
- `git status --porcelain` output is parsed by pattern rather than at a fixed column offset. Output is trimmed before parsing, which removed the leading column of an unstaged entry and shifted every field after it, silently yielding a truncated filename.

## 3.0.0

Complete rewrite. The previous release was a set of shell-wrapped Node scripts; this is a typed library with two entry points and a real test suite.

### Added
- **OpenCode plugin.** Startup pull, optional push on idle, and an `opencode_sync` tool. The CLI remains, because a plugin cannot repair the configuration that stops the plugin from loading.
- **Per-machine overrides.** `opencode-sync.overrides.jsonc` is deep-merged into the config after every pull and subtracted again before every push, so an overridden key is invisible to sync in both directions.
- **Selective session sync.** Sessions are exported one at a time as gzipped JSON shards, selected by time window, explicit include list, project directory and per-session size cap. Import is a transactional upsert; the newer `time_updated` wins.
- `opencode-sync init` / `link` for one-command setup through the GitHub CLI.
- `--dry-run` on push and pull.
- `extraPaths` for syncing arbitrary additional files.
- Cross-platform CI on Node 20/22/24 across Linux, macOS and Windows.

### Changed
- Rewritten in TypeScript, published to npm as `opencode-github-sync`.
- New terminal UI with colour that degrades correctly for pipes, `NO_COLOR` and non-truecolor terminals.
- Commit messages now use a stable pseudonym rather than the raw hostname, so a corporate asset tag can never reach the repository.
- Line endings are pinned to LF in the worktree; `text=auto` alone was rewriting shell scripts inside skills to CRLF on Windows.
- Credential syncing is opt-in and refused on public repositories.

### Removed
- Whole-database session sync and the Git LFS dependency. Committing `opencode.db` stops being viable once it passes a gigabyte, and copying it alongside a live write-ahead log risks capturing torn data.
- The shell/`.cmd` wrapper scripts, replaced by a real `bin` entry.

### Fixed
- A push is now verified by reading the remote head back; `git push` can exit zero without the remote moving.
- Symlinks and Windows junctions are refused instead of followed.
- File and directory replacements are atomic, so an interrupted sync cannot leave a half-written config.
- Nested `.git` directories left behind by skill installs are stripped from the staging copy, so skill contents are committed as files rather than as unusable gitlinks.
- A cross-process lock prevents concurrent syncs from the plugin, the CLI and multiple OpenCode windows.
