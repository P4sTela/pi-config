#!/usr/bin/env bash
# okf-validate.sh — validate OKF bundle conformance + repo conventions (index coverage, related integrity)
set -uo pipefail

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
if [ -z "$BUNDLE" ]; then echo "okf-validate: no OKF bundle found" >&2; exit 1; fi
cd "$BUNDLE"

FIX_INDEX=0
[ "${1:-}" = "--fix-index" ] && FIX_INDEX=1

declare -i ERRORS=0 WARNINGS=0

# concept files except reserved
mapfile -t FILES < <(find . -type f -name '*.md' ! -name index.md ! -name README.md ! -name log.md | sed 's|^\./||' | sort)

# --- §9 conformance: every concept has type ---
for f in "${FILES[@]}"; do
  if ! head -20 "$f" | grep -qE '^type:'; then
    echo "FAIL [conformance] missing 'type': $f"
    ERRORS+=1
  fi
  # frontmatter must start with ---
  if ! head -1 "$f" | grep -q -- '---'; then
    echo "FAIL [conformance] missing frontmatter opener: $f"
    ERRORS+=1
  fi
done

# --- index.md coverage (repo convention): every concept is listed in its dir index.md ---
for f in "${FILES[@]}"; do
  dir="$(dirname "$f")"
  [ "$dir" = "." ] && dir=""
  index="${dir:+$dir/}index.md"
  [ -f "$index" ] || index="${dir:+$dir/}README.md"
  if [ ! -f "$index" ] && [ -z "$dir" ]; then index="index.md"; fi
  if [ ! -f "$index" ]; then
    echo "WARN [index] no index.md for $f (dir=$(dirname "$f"))"
    WARNINGS+=1
    continue
  fi
  base="$(basename "$f")"
  if ! grep -qF "$base" "$index"; then
    echo "WARN [index] $f not listed in $index"
    WARNINGS+=1
    if [ "$FIX_INDEX" = 1 ]; then
      # suggest entry
      type="$(awk '/^---$/{c++; next} c==1&&/^type:/{sub("^type:[[:space:]]*",""); print; exit}' "$f" | sed 's/[[:space:]]*#.*$//')"
      title="$(awk '/^---$/{c++; next} c==1&&/^title:/{sub("^title:[[:space:]]*",""); print; exit}' "$f")"
      desc="$(awk '/^---$/{c++; next} c==1&&/^description:/{sub("^description:[[:space:]]*",""); print; exit}' "$f")"
      printf '  → append to %s:\n    * [%s](%s) - %s\n' \
        "$index" "${title:-${base%.md}}" "$base" "${desc:-<補足してください>}"
    fi
  fi
done

# --- related link integrity ---
for f in "${FILES[@]}"; do
  awk '/^---$/{c++; next} c==1 && /^related:/{sub(/^related:[[:space:]]*/,""); gsub(/[][]/,""); gsub(/,/,"\n"); print; exit}' "$f" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | while read -r r; do
      tgt="${r#/}"
      if [ ! -f "$tgt" ]; then
        echo "WARN [related] broken link: $f -> $r (target $tgt missing)"
        # warnings counted via main; re-echo handled below
      fi
    done
  # count broken links for this file
  nbreak="$(awk '/^---$/{c++; next} c==1 && /^related:/{sub(/^related:[[:space:]]*/,""); gsub(/[][]/,""); gsub(/,/,"\n"); print; exit}' "$f" \
    | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | while read -r r; do
        tgt="${r#/}"; [ ! -f "$tgt" ] && echo x
      done | wc -l)"
  WARNINGS+=$nbreak
done

echo ""
echo "summary: ${#FILES[@]} concepts, $ERRORS errors, $WARNINGS warnings"
[ "$ERRORS" -gt 0 ] && exit 2
[ "$WARNINGS" -gt 0 ] && exit 0
exit 0