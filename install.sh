#!/bin/sh
# opencode-github-sync installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/doomsday616/opencode-github-sync/main/install.sh | sh -s -- --mode auto --repo owner/name
#
# What it does, and nothing else:
#   1. checks for Node.js 18+ and git, and offers to install a missing one
#      (it asks first; it never installs anything silently)
#   2. npm install -g opencode-github-sync@latest
#   3. starts opencode-sync: the interactive menu, or a non-interactive setup
#      when --mode is given
#
# Options (all optional):
#   --mode cli|link|auto   cli: install only; link: link --repo; auto: link and
#                          make this the primary device with autosync
#   --repo owner/name      repository to link (or any git URL)
#   --interval N           autosync interval in minutes (minimum 2)
#   --lang en|zh-CN        interface language
#   --proxy URL            HTTP(S) proxy for npm and git during install and sync
#   --yes                  do not ask before installing missing prerequisites
#   --package SPEC         npm package spec to install (default: opencode-github-sync@latest)
#   --dry-run              print what would run and exit
#
# Under `curl | sh` the script itself arrives on standard input, so every
# question is read from /dev/tty instead.

set -eu

MODE=""
REPO=""
INTERVAL=""
LANG_OPT=""
PROXY=""
YES=0
DRY_RUN=0
PACKAGE="opencode-github-sync@latest"

say() { printf '%s\n' "$*"; }
err() { printf 'error: %s\n' "$*" >&2; }

need_value() {
  if [ $# -lt 2 ] || [ -z "$2" ]; then
    err "$1 needs a value"
    exit 2
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode) need_value "$@"; MODE="$2"; shift 2 ;;
    --mode=*) MODE="${1#*=}"; shift ;;
    --repo) need_value "$@"; REPO="$2"; shift 2 ;;
    --repo=*) REPO="${1#*=}"; shift ;;
    --interval) need_value "$@"; INTERVAL="$2"; shift 2 ;;
    --interval=*) INTERVAL="${1#*=}"; shift ;;
    --lang) need_value "$@"; LANG_OPT="$2"; shift 2 ;;
    --lang=*) LANG_OPT="${1#*=}"; shift ;;
    --proxy) need_value "$@"; PROXY="$2"; shift 2 ;;
    --proxy=*) PROXY="${1#*=}"; shift ;;
    --package) need_value "$@"; PACKAGE="$2"; shift 2 ;;
    --package=*) PACKAGE="${1#*=}"; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" 2>/dev/null || say "See https://github.com/doomsday616/opencode-github-sync"
      exit 0 ;;
    *) err "unknown option: $1"; exit 2 ;;
  esac
done

case "$MODE" in
  ""|cli|link|auto) ;;
  *) err "--mode must be cli, link or auto"; exit 2 ;;
esac
if [ "$MODE" = "link" ] || [ "$MODE" = "auto" ]; then
  if [ -z "$REPO" ]; then err "--mode $MODE needs --repo"; exit 2; fi
fi
if [ -n "$INTERVAL" ]; then
  case "$INTERVAL" in
    *[!0-9]*) err "--interval must be a whole number of minutes"; exit 2 ;;
  esac
  if [ "$INTERVAL" -lt 2 ]; then err "--interval must be at least 2"; exit 2; fi
fi
case "$LANG_OPT" in
  ""|en|zh-CN|zh) ;;
  *) err "--lang must be en or zh-CN"; exit 2 ;;
esac

# The proxy applies to everything this script starts: npm, git and the CLI.
if [ -n "$PROXY" ]; then
  export HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY" http_proxy="$PROXY" https_proxy="$PROXY"
  export npm_config_proxy="$PROXY" npm_config_https_proxy="$PROXY"
fi

# Arguments handed to `opencode-sync setup`.
set --
if [ -n "$MODE" ]; then set -- "$@" setup --mode "$MODE"; fi
if [ -n "$REPO" ]; then set -- "$@" --repo "$REPO"; fi
if [ -n "$INTERVAL" ]; then set -- "$@" --interval "$INTERVAL"; fi
if [ -n "$LANG_OPT" ]; then set -- "$@" --lang "$LANG_OPT"; fi
if [ -n "$PROXY" ]; then set -- "$@" --proxy "$PROXY"; fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "npm install -g $PACKAGE"
  if [ $# -gt 0 ]; then say "opencode-sync $*"; else say "opencode-sync"; fi
  if [ -n "$PROXY" ]; then say "proxy $PROXY"; fi
  exit 0
fi

# --- Questions go to the terminal, not to the pipe ---

HAVE_TTY=0
# Probe in a subshell: in a strict POSIX shell (dash) a failed redirection on
# a special builtin such as `:` exits the whole script, silently, with status 2.
if (exec </dev/tty) 2>/dev/null; then HAVE_TTY=1; fi

ask_yes_no() {
  # $1 = question. Default is No.
  if [ "$HAVE_TTY" -ne 1 ]; then return 1; fi
  printf '%s [y/N] ' "$1" >/dev/tty
  answer=""
  read -r answer </dev/tty || answer=""
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# --- Prerequisites ---

package_manager_command() {
  # $1 = node | git. Prints an install command for this system, or nothing.
  what="$1"
  if command -v brew >/dev/null 2>&1; then
    if [ "$what" = node ]; then echo "brew install node"; else echo "brew install git"; fi
  elif command -v apt-get >/dev/null 2>&1; then
    if [ "$what" = node ]; then echo "sudo apt-get install -y nodejs npm"; else echo "sudo apt-get install -y git"; fi
  elif command -v dnf >/dev/null 2>&1; then
    if [ "$what" = node ]; then echo "sudo dnf install -y nodejs npm"; else echo "sudo dnf install -y git"; fi
  elif command -v pacman >/dev/null 2>&1; then
    if [ "$what" = node ]; then echo "sudo pacman -S --noconfirm nodejs npm"; else echo "sudo pacman -S --noconfirm git"; fi
  elif command -v apk >/dev/null 2>&1; then
    if [ "$what" = node ]; then echo "sudo apk add nodejs npm"; else echo "sudo apk add git"; fi
  elif command -v zypper >/dev/null 2>&1; then
    if [ "$what" = node ]; then echo "sudo zypper install -y nodejs npm"; else echo "sudo zypper install -y git"; fi
  fi
}

offer_install() {
  # $1 = node | git, $2 = why it is needed
  what="$1"
  say "$2"
  cmd=$(package_manager_command "$what")
  if [ -z "$cmd" ]; then
    if [ "$what" = node ]; then say "Install Node.js 18 or newer from https://nodejs.org and run this again."
    else say "Install git from https://git-scm.com and run this again."; fi
    exit 1
  fi
  say "It can be installed with:"
  say "  $cmd"
  if [ "$YES" -eq 1 ] || ask_yes_no "Run that now?"; then
    case "$cmd" in
      # A fresh container has no package index yet; install would fail.
      *apt-get*) cmd="sudo apt-get update && $cmd" ;;
    esac
    if [ "$HAVE_TTY" -eq 1 ]; then sh -c "$cmd" </dev/tty; else sh -c "$cmd"; fi
  else
    say "Not installed. Run the command above, then this installer again."
    exit 1
  fi
}

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

node_ok() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [ "$(node_major)" -ge 18 ]
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  offer_install node "Node.js (18 or newer) and npm are needed and were not found."
elif [ "$(node_major)" -lt 18 ]; then
  offer_install node "Node.js $(node -v) is too old; 18 or newer is needed."
fi
# A distribution package can still be older than 18, so check the result.
if ! node_ok; then
  err "Node.js 18 or newer with npm is still not available."
  say "Install it from https://nodejs.org and run this again."
  exit 1
fi
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null; then
  say "Note: Node.js $(node -v) syncs configuration fine; session sync needs 22.5 or newer."
fi
if ! command -v git >/dev/null 2>&1; then
  offer_install git "git is needed and was not found."
  if ! command -v git >/dev/null 2>&1; then
    err "git is still not available."
    exit 1
  fi
fi

# --- Install ---

say "Installing $PACKAGE ..."
if ! npm install -g "$PACKAGE"; then
  err "npm install -g failed."
  say "If this is a permissions error, point npm at a folder you own:"
  say "  npm config set prefix \"\$HOME/.local\" && export PATH=\"\$HOME/.local/bin:\$PATH\""
  exit 1
fi

BIN="$(npm prefix -g 2>/dev/null)/bin/opencode-sync"
if [ ! -x "$BIN" ]; then BIN="$(command -v opencode-sync 2>/dev/null || true)"; fi
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  err "opencode-sync was installed but cannot be found on PATH."
  say "Add \"$(npm prefix -g)/bin\" to PATH, then run: opencode-sync"
  exit 1
fi

if [ $# -gt 0 ]; then
  if [ "$HAVE_TTY" -eq 1 ]; then exec "$BIN" "$@" </dev/tty; fi
  exec "$BIN" "$@"
fi

if [ "$HAVE_TTY" -eq 1 ]; then
  exec "$BIN" </dev/tty
fi
say "Installed. Run opencode-sync to open the menu."
