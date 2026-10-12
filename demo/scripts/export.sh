#!/usr/bin/env bash
# Host-side filesystem publication only; validation/build/test execution stays in Docker.
# Sourced by run-docker.sh and exercised against disposable filesystems in Docker.

safe_tree() {
  local root="$1" entry relative separators count=0 bytes=0 size links find_status complete=false
  [[ -d "$root" && ! -L "$root" ]] || return 1
  while IFS= read -r -d '' entry; do
    if [[ -z "$entry" ]]; then
      IFS= read -r -d '' find_status || return 1
      [[ "$find_status" == 0 ]] || return 1
      complete=true
      break
    fi
    ((count+=1))
    relative="${entry#"$root/"}"
    separators="${relative//[^\/]/}"
    [[ "$count" -le 10000 && "${#separators}" -le 24 && ! -L "$entry" ]] || return 1
    if [[ -f "$entry" ]]; then
      read -r size links < <(stat -c '%s %h' -- "$entry") || return 1
      [[ "$links" == 1 && "$size" -le 16777216 ]] || return 1
      ((bytes+=size))
      [[ "$bytes" -le 268435456 ]] || return 1
    elif [[ ! -d "$entry" ]]; then return 1; fi
  done < <(find_status=0; find -P "$root" -mindepth 1 -maxdepth 26 -print0 || find_status=$?; printf '\0%s\0' "$find_status")
  "$complete"
}

# Replace only a fixed GENERATED directory under the verified demo root. Never merge.
publish_generated() {
  local stage="$1" name="$2" destination="$demo_root/$2" backup="$export_stage/old-$2"
  case "$name" in dist|playwright-report|test-results) ;; *) return 1 ;; esac
  safe_tree "$stage" || return 1
  [[ ! -L "$destination" ]] || return 1
  if [[ -e "$destination" ]]; then
    safe_tree "$destination" || return 1
    mv -- "$destination" "$backup" || return 1
  fi
  if ! mv -- "$stage" "$destination"; then
    if [[ -d "$backup" ]]; then mv -- "$backup" "$destination" || true; fi
    return 1
  fi
}

# Delta contains only added/byte-changed demo PNGs, not the baseline directory from the image.
publish_baselines() {
  local delta="$1" target="$demo_root/visual-baselines" file name
  safe_tree "$delta" || return 1
  [[ ! -L "$target" ]] || return 1
  if [[ ! -e "$target" ]]; then mkdir -- "$target" || return 1; fi
  [[ -d "$target" && ! -L "$target/demo.spec.ts" ]] || return 1
  if [[ ! -e "$target/demo.spec.ts" ]]; then mkdir -- "$target/demo.spec.ts" || return 1; fi
  [[ -d "$target/demo.spec.ts" ]] || return 1
  while IFS= read -r -d '' file; do
    name="${file#"$delta/"}"
    [[ "$name" =~ ^demo.spec.ts/demo-(chat|files|git|terminal|models|tools|reset)-(desktop|mobile)-(light|dark)\.png$ ]] || return 1
    [[ ! -L "$target/$name" ]] || return 1
    if [[ -e "$target/$name" ]]; then
      [[ -f "$target/$name" && "$(stat -c '%h' -- "$target/$name")" == 1 ]] || return 1
    fi
  done < <(find -P "$delta" -type f -print0)
  while IFS= read -r -d '' file; do
    name="${file#"$delta/"}"
    mv -f -- "$file" "$target/$name" || return 1
  done < <(find -P "$delta" -type f -print0)
}
