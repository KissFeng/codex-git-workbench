#!/bin/sh
set -eu

REPO="KissFeng/codex-git-workbench"
MARKETPLACE="kissfeng-git-tools"
PLUGIN="codex-git-workbench@${MARKETPLACE}"
REF="main"
WANT_CODEX=0
WANT_ANTIGRAVITY=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --codex) WANT_CODEX=1 ;;
    --antigravity) WANT_ANTIGRAVITY=1 ;;
    --all) WANT_CODEX=1; WANT_ANTIGRAVITY=1 ;;
    --ref)
      shift
      [ $# -gt 0 ] || { echo "Missing value for --ref" >&2; exit 1; }
      REF="$1"
      ;;
    --ref=*) REF="${1#--ref=}" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: install.sh [--codex] [--antigravity] [--all] [--ref <tag-or-branch>] [--dry-run]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
  shift
done

HAS_CODEX_CLI=0
if command -v codex >/dev/null 2>&1; then
  HAS_CODEX_CLI=1
fi

HAS_ANTIGRAVITY=0
AG_DATA_DIR="${ANTIGRAVITY_APP_DATA_DIR:-$HOME/.gemini/antigravity}"
if [ -d "$AG_DATA_DIR" ] || [ -d "$HOME/.gemini/config" ]; then
  HAS_ANTIGRAVITY=1
fi

if [ "$WANT_CODEX" -eq 0 ] && [ "$WANT_ANTIGRAVITY" -eq 0 ]; then
  WANT_CODEX="$HAS_CODEX_CLI"
  WANT_ANTIGRAVITY="$HAS_ANTIGRAVITY"
fi

if [ "$WANT_CODEX" -eq 0 ] && [ "$WANT_ANTIGRAVITY" -eq 0 ]; then
  echo "[git-workbench] Neither Codex CLI nor Antigravity was detected." >&2
  echo "Pass --codex, --antigravity, or --all to install explicitly." >&2
  exit 1
fi

if [ "$WANT_CODEX" -eq 1 ]; then
  if [ "$HAS_CODEX_CLI" -eq 0 ] && [ "$DRY_RUN" -eq 0 ]; then
    echo "[git-workbench] Codex CLI ('codex') was not found on PATH." >&2
    exit 1
  fi
  echo "[git-workbench] Installing for Codex (ref: ${REF})..."
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] codex plugin marketplace add ${REPO} --ref ${REF}"
    echo "[dry-run] codex plugin add ${PLUGIN}"
  else
    codex plugin marketplace remove "${MARKETPLACE}" >/dev/null 2>&1 || true
    codex plugin marketplace add "${REPO}" --ref "${REF}"
    codex plugin add "${PLUGIN}"
    echo "[git-workbench] Codex plugin installed. Fully quit and reopen Codex desktop."
  fi
fi

if [ "$WANT_ANTIGRAVITY" -eq 1 ]; then
  echo "[git-workbench] Installing for Antigravity (ref: ${REF})..."
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "[dry-run] Download https://github.com/${REPO}/archive/${REF}.tar.gz and run node scripts/install-antigravity.mjs --install"
  else
    command -v curl >/dev/null 2>&1 || { echo "[git-workbench] curl is required." >&2; exit 1; }
    command -v tar >/dev/null 2>&1 || { echo "[git-workbench] tar is required." >&2; exit 1; }
    command -v node >/dev/null 2>&1 || { echo "[git-workbench] Node.js is required." >&2; exit 1; }

    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
    ARCHIVE_URL="https://github.com/${REPO}/archive/${REF}.tar.gz"
    curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$TMP_DIR"
    SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/scripts/install-antigravity.mjs" ]; then
      echo "[git-workbench] Failed to locate Antigravity installer in downloaded archive (ref: ${REF})." >&2
      exit 1
    fi
    node "$SRC_DIR/scripts/install-antigravity.mjs" --install
    echo "[git-workbench] Antigravity plugin installed. Open Git Workbench from the right auxiliary pane."
  fi
fi
