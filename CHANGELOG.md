# Changelog

[简体中文](./CHANGELOG.zh-CN.md)

## 3.1.1

### Fixed
- A push that rebased onto other machines' commits now writes the merged
  result out to the real directories (`~/.agents/skills`, state, data, extra
  paths). Previously the new files landed only in the repository, a later pull
  saw nothing incoming and skipped the write-out, and the next push staged the
  stale local tree and deleted another machine's new skills. A push with nothing
  local now fast-forwards and writes out the same way.
- The commit last written out is recorded in `.git/info/opencode-sync-stage-out`.
  When HEAD has moved past it (for example a push that stopped after the
  rebase), the next push or pull writes the repository out before doing
  anything else, so the gap can no longer be published as deletions.
- An `extraPaths` source that does not exist on this machine no longer deletes
  the shared repository copy. It is skipped and reported; other machines keep
  receiving it.
- Writing out a directory `extraPaths` entry no longer deletes local files that
  are not in the repository copy, so a tool's runtime files beside its synced
  config survive a pull. `--force` still makes it an exact copy. File entries
  continue to replace only that file.

## 3.1.0

### Added
- **OpenCode 2 support.** One package now loads on both OpenCode 1.x and 2.x.
  Thanks @vitaly74 (#6). How it works:
  - The default export is a single object that satisfies both loaders. OpenCode
    2 looks for `{ id, setup }`: `setup(ctx)` registers the `opencode_sync`
    tool through `ctx.tool.transform`, subscribes to `session.idle` through
    `ctx.event.subscribe` for the optional idle push, and runs the startup pull.
    OpenCode 1.x (1.3.4 and later) sees the same object's `id` and `server()`
    and calls `server()` once, so the plugin is registered exactly once.
  - No dependency on `@opencode/plugin`; the V2 context is used structurally.
  - **Config key.** OpenCode 1.x reads only `"plugin"` and silently drops
    `"plugins"`. OpenCode 2 reads its native `"plugins"` and still accepts the
    legacy `"plugin"`. So `"plugin": ["opencode-github-sync"]` is the one form
    that works on both, and it is what the README recommends. A 2.x-only setup
    may use `"plugins"`, but never list the plugin under both keys: 2.x loads
    both lists.
  - Plugin cache pruning reads both keys, so a mixed fleet where some machines
    are on 1.x and some on 2.x keeps every plugin either version needs.
  - OpenCode 1.0–1.3.3 iterate every export and call each as a function, which
    the new object default export cannot satisfy. Stay on 3.0.1 there.

### Fixed
- Session import no longer cascade-deletes sessions. `INSERT OR REPLACE`
  deletes the conflicting row before inserting, so replacing a shared project
  row cascaded through `ON DELETE CASCADE` and removed every session imported
  before it. It is replaced by a real `INSERT ... ON CONFLICT DO UPDATE` upsert
  that never deletes and keeps newer-`time_updated`-wins per row (#2).
- The synthetic `global` project is machine-specific, so it is no longer
  exported, and importing an older shard that carries it never overwrites the
  local row (#4).
- Session shard export is deterministic: an unchanged session produces a
  byte-identical shard, so it no longer shows up as a change on every push.
  Thanks @aquelejota (#5, #3).
- The session tests now actually run under vitest; previously `node:sqlite`
  failed to load there and every session test returned early.
- Plugin cache pruning reads both the `plugin` and `plugins` keys and
  understands `[spec, options]` tuples and `{ package }` objects, so a plugin
  listed in either form is no longer pruned from the cache.

### Changed
- The minimum supported OpenCode 1.x is now 1.3.4. OpenCode 1.0–1.3.3 cannot
  load this release; stay on 3.0.1 there.

## 3.0.1

### Fixed
- `status` no longer reports the config file as uncommitted work on machines
  that use per-machine overrides. The file on disk is *supposed* to differ from
  the committed version once overrides are in play, so plain `git status`
  flagged it as modified forever — a warning the user could never clear. The
  config is now compared with overrides subtracted, so only genuine edits count.
- `git status --porcelain` output is parsed by pattern rather than at a fixed
  column offset. Output is trimmed before parsing, which removed the leading
  column of an unstaged entry and shifted every field after it, silently
  yielding a truncated filename.

## 3.0.0

Complete rewrite. The previous release was a set of shell-wrapped Node scripts;
this is a typed library with two entry points and a real test suite.

### Added
- **OpenCode plugin.** Startup pull, optional push on idle, and an
  `opencode_sync` tool. The CLI remains, because a plugin cannot repair the
  configuration that stops the plugin from loading.
- **Per-machine overrides.** `opencode-sync.overrides.jsonc` is deep-merged into
  the config after every pull and subtracted again before every push, so an
  overridden key is invisible to sync in both directions.
- **Selective session sync.** Sessions are exported one at a time as gzipped
  JSON shards, selected by time window, explicit include list, project directory
  and per-session size cap. Import is a transactional upsert; the newer
  `time_updated` wins.
- `opencode-sync init` / `link` for one-command setup through the GitHub CLI.
- `--dry-run` on push and pull.
- `extraPaths` for syncing arbitrary additional files.
- Cross-platform CI on Node 20/22/24 across Linux, macOS and Windows.

### Changed
- Rewritten in TypeScript, published to npm as `opencode-github-sync`.
- New terminal UI with colour that degrades correctly for pipes, `NO_COLOR`
  and non-truecolor terminals.
- Commit messages now use a stable pseudonym rather than the raw hostname, so a
  corporate asset tag can never reach the repository.
- Line endings are pinned to LF in the worktree; `text=auto` alone was rewriting
  shell scripts inside skills to CRLF on Windows.
- Credential syncing is opt-in and refused on public repositories.

### Removed
- Whole-database session sync and the Git LFS dependency. Committing
  `opencode.db` stops being viable once it passes a gigabyte, and copying it
  alongside a live write-ahead log risks capturing torn data.
- The shell/`.cmd` wrapper scripts, replaced by a real `bin` entry.

### Fixed
- A push is now verified by reading the remote head back; `git push` can exit
  zero without the remote moving.
- Symlinks and Windows junctions are refused instead of followed.
- File and directory replacements are atomic, so an interrupted sync cannot
  leave a half-written config.
- Nested `.git` directories left behind by skill installs are stripped from the
  staging copy, so skill contents are committed as files rather than as unusable
  gitlinks.
- A cross-process lock prevents concurrent syncs from the plugin, the CLI and
  multiple OpenCode windows.
