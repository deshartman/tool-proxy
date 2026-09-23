#!/usr/bin/env bash
# Make this repo's tracked skills discoverable by Claude Code.
#
# THE PROBLEM THIS SOLVES (Q-D2 in architectural-plans/DEPLOY-ARCHITECTURE.md)
#
# Claude Code discovers project skills at .claude/skills/<name>/SKILL.md. But
# `.claude/` is commonly ignored globally (`**/.claude/` in a user's
# ~/.config/git/ignore), so nothing under it can be committed — the skill would
# be invisible to every fresh clone no matter what we do in this repo.
#
# So the skills live at docs/skills/<name>/ where they ARE tracked, and this
# script symlinks them into place. Idempotent; safe to re-run.
#
# Run it after cloning:
#   ./scripts/link-skills.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/docs/skills"
DEST="$ROOT/.claude/skills"

if [ ! -d "$SRC" ]; then
  echo "[link-skills] no docs/skills/ — nothing to link" >&2
  exit 0
fi

mkdir -p "$DEST"

linked=0
for dir in "$SRC"/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  target="$DEST/$name"

  # Already correct? Say nothing and move on — this script is meant to be
  # re-runnable without noise.
  if [ -L "$target" ] && [ "$(readlink "$target")" = "../../docs/skills/$name" ]; then
    echo "[link-skills] $name already linked"
    continue
  fi

  # A real directory here is someone's own local skill of the same name. Do NOT
  # clobber it — warn and skip, because losing hand-written work to a setup
  # script is far worse than a missing skill.
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "[link-skills] WARN: $target exists and is not a symlink — leaving it alone" >&2
    continue
  fi

  rm -f "$target"
  # Relative, not absolute: an absolute link breaks the moment the checkout
  # moves, and the drop-in scanner has already been bitten by exactly that
  # (see the dangling-symlink handling in connector/src/dropin.ts).
  ln -s "../../docs/skills/$name" "$target"
  echo "[link-skills] linked $name"
  linked=$((linked + 1))
done

echo "[link-skills] done ($linked newly linked). Restart Claude Code to pick up new skills."
