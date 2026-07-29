# Changelog

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
