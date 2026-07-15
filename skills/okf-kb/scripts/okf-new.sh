#!/usr/bin/env bash
# okf-new.sh — scaffold a new OKF concept doc + update directory index.md
# Usage: okf-new.sh <dir> <filename> --type <t> --title '<t>' [--desc '<d>'] [--tags 'a,b'] [--related '/x.md']
set -euo pipefail

find_bundle() {
  local dir="$PWD"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    for cand in "$dir/index.md" "$dir/docs/index.md" "$dir/knowledge/index.md"; do
      if [ -f "$cand" ] && head -10 "$cand" | grep -qE '^okf_version:'; then
        printf '%s\n' "$(cd "$(dirname "$cand")" && pwd)"; return 0
      fi
    done
    dir="$(dirname "$dir")"
  done
  return 1
}

BUNDLE="$(find_bundle || true)"
if [ -z "$BUNDLE" ]; then
  echo "okf-new: no OKF bundle found from $PWD" >&2; exit 1
fi
cd "$BUNDLE"

DIR="${1:-}"; FILE="${2:-}"
[ -n "$DIR" ] && [ -n "$FILE" ] || {
  echo "usage: okf-new.sh <dir> <filename> --type <t> --title '<t>' [--desc] [--tags] [--related]" >&2; exit 1; }
shift 2

TYPE=""; TITLE=""; DESC=""; TAGS=""; RELATED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --type) TYPE="$2"; shift 2 ;;
    --title) TITLE="$2"; shift 2 ;;
    --desc) DESC="$2"; shift 2 ;;
    --tags) TAGS="$2"; shift 2 ;;
    --related) RELATED="$2"; shift 2 ;;
    *) echo "okf-new: unknown option $1" >&2; exit 1 ;;
  esac
done

[ -n "$TYPE" ] || { echo "okf-new: --type is required (OKF conformance §9)" >&2; exit 1; }
[ -n "$TITLE" ] || { echo "okf-new: --title is required (repo convention)" >&2; exit 1; }

mkdir -p "$DIR"
PATH_="$DIR/$FILE"
[ "${FILE: -3}" = ".md" ] || PATH_="$DIR/${FILE}.md"
[ -e "$PATH_" ] && { echo "okf-new: already exists: $PATH_" >&2; exit 1; }

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# build tags/related yaml lines
TAGS_LINE=""
if [ -n "$TAGS" ]; then
  # normalize to [a, b]
  norm="$(printf '%s' "$TAGS" | sed 's/,[[:space:]]*/, /g; s/^ *//; s/ *$//')"
  TAGS_LINE="tags: [${norm}]"
fi
REL_LINE=""
if [ -n "$RELATED" ]; then
  # normalize comma list
  rel="$(printf '%s' "$RELATED" | sed 's/,[[:space:]]*/, /g')"
  REL_LINE="related: [${rel}]"
fi

{
  printf -- '---\n'
  printf 'type: %s\n' "$TYPE"
  printf 'title: %s\n' "$TITLE"
  [ -n "$DESC" ] && printf 'description: %s\n' "$DESC"
  [ -n "$TAGS_LINE" ] && printf '%s\n' "$TAGS_LINE"
  printf 'timestamp: %s\n' "$TS"
  [ -n "$REL_LINE" ] && printf '%s\n' "$REL_LINE"
  printf -- '---\n\n'
  printf '# %s\n\n' "$TITLE"
  printf '<本文をここに記述>\n'
} > "$PATH_"

# append to directory index.md (create if absent, with okf_version-less heading)
INDEX="$DIR/index.md"
if [ ! -f "$INDEX" ]; then
  {
    printf '# %s\n\n' "$(basename "$DIR")"
  } > "$INDEX"
fi
# append entry — match existing "* [Title](file.md) - desc" style (extension kept)
LINK_NAME="$(basename "$PATH_")"
ENTRY="* [${TITLE}](${LINK_NAME}) - ${DESC:-<説明>}"
printf '%s\n' "$ENTRY" >> "$INDEX"

echo "created: $PATH_"
echo "updated: $INDEX"
echo "timestamp: $TS"