#!/usr/bin/env bash
# okf-query.sh — OKF v0.1 bundle navigator (compact, context-saving output)
# Usage: see SKILL.md
set -euo pipefail

# ---------- bundle discovery ----------
find_bundle() {
  local dir="$PWD"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    for cand in "$dir/index.md" "$dir/docs/index.md" "$dir/knowledge/index.md" "$dir/okf/index.md"; do
      if [ -f "$cand" ] && head -10 "$cand" | grep -qE '^okf_version:'; then
        printf '%s\n' "$(cd "$(dirname "$cand")" && pwd)"
        return 0
      fi
    done
    dir="$(dirname "$dir")"
  done
  return 1
}

BUNDLE="$(find_bundle || true)"
if [ -z "$BUNDLE" ]; then
  echo "okf-query: no OKF bundle found (no index.md with okf_version: walking up from $PWD)" >&2
  exit 1
fi
cd "$BUNDLE"

# ---------- helpers ----------

# concept files = *.md excluding reserved (index.md, README.md, log.md)
concepts() {
  find . -type f -name '*.md' \
    ! -name index.md ! -name README.md ! -name log.md \
    | sed 's|^\./||' | LC_ALL=C sort
}

# extract a single frontmatter field (first match). $1=file, $2=key
fm_field() {
  awk -v k="$2" '
    /^---$/ { c++; next }
    c==1 && $0 ~ "^"k":" {
      sub("^"k":[[:space:]]*",""); print; exit
    }
  ' "$1"
}

# extract tags as space-separated (strips [] and commas). $1=file
fm_tags() {
  awk '
    /^---$/ { c++; next }
    c==1 && /^tags:/ {
      sub(/^tags:[[:space:]]*/,""); gsub(/[][]/,""); gsub(/,/," ");
      print; exit
    }
    c==1 && /^tags:/ { in_tags=1; sub(/^tags:[[:space:]]*/,""); gsub(/[][]/,""); gsub(/,/," "); printf "%s ", $0; next }
  ' "$1" | tr -s ' ' | sed 's/^ //;s/ $//'
}

# normalized doc path: strips leading ./ , adds .md if missing. $1=path-or-id
norm_doc() {
  local p="$1"
  p="${p#./}"
  [ "${p: -3}" != ".md" ] && p="$p.md"
  printf '%s\n' "$p"
}

# ---------- commands ----------

cmd_list() {
  local f type title tags
  while read -r f; do
    type="$(fm_field "$f" type | sed 's/[[:space:]]*#.*$//')"
    title="$(fm_field "$f" title)"
    tags="$(fm_tags "$f")"
    printf '%s\t%s\t%s\t%s\n' "$f" "${type:-?}" "${title:-$(basename "$f" .md)}" "${tags}"
  done < <(concepts)
}

cmd_dirs() {
  concepts | awk -F/ 'NF>1{print $1} NF==1{print "."}' | sort | uniq -c | sort -rn | awk '{print $2"\t"$1}'
}

cmd_types() {
  while read -r f; do
    fm_field "$f" type | sed 's/[[:space:]]*#.*$//'
  done < <(concepts) | sed 's/^$/(none)/' | sort | uniq -c | sort -rn | awk '{print $2"\t"$1}'
}

cmd_tags() {
  while read -r f; do
    fm_tags "$f"
  done < <(concepts) | tr ' ' '\n' | grep -v '^$' | sort | uniq -c | sort -rn | awk '{print $2"\t"$1}'
}

cmd_recent() {
  local n="${1:-10}"
  while read -r f; do
    ts="$(fm_field "$f" timestamp)"
    # sortable: keep only date-ish chars; fall back to filename date if missing
    if [ -z "$ts" ]; then
      ts="$(printf '%s' "$f" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}' || printf '0000-00-00')"
    fi
    printf '%s\t%s\n' "$ts" "$f"
  done < <(concepts) | LC_ALL=C sort -rn | head -n "$n" | while IFS=$'\t' read -r ts f; do
    title="$(fm_field "$f" title)"
    printf '%s\t%s\t%s\n' "$f" "$ts" "${title:-$(basename "$f" .md)}"
  done
}

cmd_tag() {
  [ $# -eq 0 ] && { echo "usage: okf-query.sh tag <tag> [<tag>...]" >&2; exit 1; }
  local -a want=("$@")
  local f tags ok t
  while read -r f; do
    tags="$(fm_tags "$f")"
    ok=1
    for t in "${want[@]}"; do
      case " $tags " in *" $t "*) ;; *) ok=0 ;; esac
    done
    [ "$ok" = 1 ] || continue
    title="$(fm_field "$f" title)"
    printf '%s\t%s\n' "$f" "${title:-$(basename "$f" .md)}"
  done < <(concepts)
}

cmd_type() {
  [ $# -eq 1 ] || { echo "usage: okf-query.sh type <type>" >&2; exit 1; }
  local want="$1" f type
  while read -r f; do
    type="$(fm_field "$f" type | sed 's/[[:space:]]*#.*$//')"
    [ "$type" = "$want" ] || continue
    title="$(fm_field "$f" title)"
    printf '%s\t%s\n' "$f" "${title:-$(basename "$f" .md)}"
  done < <(concepts)
}

cmd_find() {
  [ $# -ge 1 ] || { echo "usage: okf-query.sh find <keyword>" >&2; exit 1; }
  local kw="$1" f title desc tags body hit
  while read -r f; do
    title="$(fm_field "$f" title)"
    desc="$(fm_field "$f" description)"
    tags="$(fm_tags "$f")"
    # body = everything after first frontmatter block
    body="$(awk '/^---$/{c++; next} c>=2{print}' "$f")"
    if printf '%s\n%s\n%s\n%s\n' "$title" "$desc" "$tags" "$body" | grep -qi -- "$kw"; then
      printf '%s\t%s\t%s\n' "$f" "${title:-$(basename "$f" .md)}" "${desc}"
    fi
  done < <(concepts)
}

cmd_related() {
  [ $# -eq 1 ] || { echo "usage: okf-query.sh related <doc>" >&2; exit 1; }
  local self; self="$(norm_doc "$1")"
  [ -f "$self" ] || { echo "okf-query: not found: $self" >&2; exit 1; }
  # extract related: [/a.md, /b.md] — bundle-relative, leading /
  awk '
    /^---$/ { c++; next }
    c==1 && /^related:/ {
      sub(/^related:[[:space:]]*/,""); gsub(/[][]/,""); gsub(/,/,"\n")
      print; exit
    }
  ' "$self" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | while read -r r; do
    # strip leading /, resolve relative to bundle
    local="${r#/}"
    if [ -f "$local" ]; then
      title="$(fm_field "$local" title)"
      printf '%s\t%s\n' "$local" "${title:-$(basename "$local" .md)}"
    else
      printf '%s\t(BROKEN)\n' "$local"
    fi
  done
}

cmd_backlinks() {
  [ $# -eq 1 ] || { echo "usage: okf-query.sh backlinks <doc>" >&2; exit 1; }
  local self; self="$(norm_doc "$1")"
  # self as bundle-relative-with-leading-slash and as bare path
  local needle="/${self#./}"
  local f
  while read -r f; do
    [ "$f" = "$self" ] && continue
    # check frontmatter related field
    rel="$(awk '/^---$/{c++; next} c==1 && /^related:/{sub(/^related:[[:space:]]*/,""); gsub(/[][]/,""); gsub(/,/," "); print; exit}' "$f")"
    case " $rel " in
      *"$needle "*|*" $self "*)
        title="$(fm_field "$f" title)"
        printf '%s\t%s\n' "$f" "${title:-$(basename "$f" .md)}"
        ;;
    esac
  done < <(concepts)
}

cmd_graph() {
  [ $# -ge 1 ] || { echo "usage: okf-query.sh graph <doc> [depth]" >&2; exit 1; }
  local start; start="$(norm_doc "$1")"
  local depth="${2:-2}"
  [ -f "$start" ] || { echo "okf-query: not found: $start" >&2; exit 1; }
  # BFS — collect next-depth nodes in a temp file (subshell-safe)
  VIS=/tmp/okf_graph_visited.$$; NEXT=/tmp/okf_graph_next.$$
  : > "$VIS"; printf '%s\n' "$start" >> "$VIS"
  local cur=("$start")
  local d=0
  while [ "$d" -lt "$depth" ] && [ ${#cur[@]} -gt 0 ]; do
    : > "$NEXT"
    for node in "${cur[@]}"; do
      [ -f "$node" ] || continue
      awk '/^---$/{c++; next} c==1 && /^related:/{sub(/^related:[[:space:]]*/,""); gsub(/[][]/,""); gsub(/,/,"\n"); print; exit}' "$node" \
        | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' | while read -r r; do
          tgt="${r#/}"
          [ -f "$tgt" ] || continue
          if ! grep -qxF "$tgt" "$VIS" 2>/dev/null; then
            printf '%s\n' "$tgt" >> "$VIS"
            printf '%s\n' "$tgt" >> "$NEXT"
            title="$(fm_field "$tgt" title)"
            printf '%s\t%s\td=%d\t%s\n' "$node" "$tgt" "$((d+1))" "${title:-$(basename "$tgt" .md)}"
          fi
        done
    done
    mapfile -t cur < "$NEXT"
    d=$((d+1))
  done
  rm -f "$VIS" "$NEXT"
}

cmd_show() {
  [ $# -eq 1 ] || { echo "usage: okf-query.sh show <doc>" >&2; exit 1; }
  local f; f="$(norm_doc "$1")"
  [ -f "$f" ] || { echo "okf-query: not found: $f" >&2; exit 1; }
  cmd_meta "$f"
  echo "--- body (first 10 lines) ---"
  awk '/^---$/{c++; next} c>=2{print}' "$f" | sed -n '1,10p'
}

cmd_meta() {
  [ $# -eq 1 ] || { echo "usage: okf-query.sh meta <doc>" >&2; exit 1; }
  local f; f="$(norm_doc "$1")"
  [ -f "$f" ] || { echo "okf-query: not found: $f" >&2; exit 1; }
  echo "path: $f"
  for k in type title description tags timestamp related; do
    v="$(fm_field "$f" "$k")"
    if [ -n "$v" ]; then printf '%s: %s\n' "$k" "$v"; fi
  done
}

# ---------- dispatch ----------
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  list)      cmd_list "$@" ;;
  dirs)      cmd_dirs "$@" ;;
  types)     cmd_types "$@" ;;
  tags)      cmd_tags "$@" ;;
  recent)    cmd_recent "$@" ;;
  tag)       cmd_tag "$@" ;;
  type)      cmd_type "$@" ;;
  find)      cmd_find "$@" ;;
  related)   cmd_related "$@" ;;
  backlinks) cmd_backlinks "$@" ;;
  graph)     cmd_graph "$@" ;;
  show)      cmd_show "$@" ;;
  meta)      cmd_meta "$@" ;;
  -h|--help|"")
    sed -n '2,4p' "$0" >&2
    echo "commands: list dirs types tags recent tag type find related backlinks graph show meta" >&2
    ;;
  *) echo "okf-query: unknown command '$cmd'" >&2; exit 1 ;;
esac