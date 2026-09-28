#!/usr/bin/env bash
# Shared path and archive checks for the local backup/restore scripts.
# This file is sourced by those scripts; it is not a standalone command.

require_absolute_path() {
  case "$1" in
    /*) ;;
    *) echo "ERROR: $2 must be an absolute path: $1" >&2; return 1 ;;
  esac
}

reject_symlink_components() {
  local path_value="$1"
  local current="/"
  local remainder="${path_value#/}"
  local component
  IFS='/' read -r -a path_parts <<<"$remainder"
  for component in "${path_parts[@]}"; do
    [ -z "$component" ] && continue
    case "$component" in
      .|..)
        echo "ERROR: path may not contain . or .. components: $path_value" >&2
        return 1
        ;;
    esac
    current="${current%/}/$component"
    if [ -L "$current" ]; then
      echo "ERROR: refusing symlink path component: $current" >&2
      return 1
    fi
  done
}

reject_dangerous_root() {
  local root_value="$1"
  local root_real="$2"
  case "$root_real" in
    /|/Users|/private|/private/tmp|/private/var|/tmp|/var|/home|/usr|/bin|/sbin|/System|/Applications|/Library)
      echo "ERROR: refusing broad/system local root: $root_value" >&2
      return 1
      ;;
  esac
  case "$REPO_ROOT/" in
    "$root_real/"*)
      echo "ERROR: local root may not be an ancestor of the repository: $root_value" >&2
      return 1
      ;;
  esac
}

require_marked_data_root() {
  local raw_root="$1"
  require_absolute_path "$raw_root" "LOCAL_DATA_ROOT" || return 1
  reject_symlink_components "$raw_root" || return 1
  if [ ! -d "$raw_root" ] || [ -L "$raw_root" ]; then
    echo "ERROR: LOCAL_DATA_ROOT is not a real directory: $raw_root" >&2
    return 1
  fi
  local root_real
  root_real="$(cd "$raw_root" && pwd -P)" || return 1
  reject_dangerous_root "$raw_root" "$root_real" || return 1
  local marker="$root_real/.infinity-agents-root"
  local expected
  expected="$(printf 'infinity-agents-root-v1\npath=%s\nkind=data' "$root_real")"
  if [ -L "$marker" ] || [ ! -f "$marker" ]; then
    echo "ERROR: LOCAL_DATA_ROOT has no matching startup marker: $root_real" >&2
    return 1
  fi
  if [ "$(cat "$marker")" != "$expected" ]; then
    echo "ERROR: LOCAL_DATA_ROOT marker does not belong to this installation: $root_real" >&2
    return 1
  fi
  printf '%s\n' "$root_real"
}

require_marked_object_root() {
  local data_real="$1"
  local raw_object_root="$2"
  require_absolute_path "$raw_object_root" "LOCAL_OBJECT_ROOT" || return 1
  reject_symlink_components "$raw_object_root" || return 1
  local parent_raw
  local object_name
  parent_raw="$(dirname "$raw_object_root")"
  object_name="$(basename "$raw_object_root")"
  if [ "$object_name" != "objects" ] || [ ! -d "$parent_raw" ] || [ -L "$parent_raw" ]; then
    echo "ERROR: LOCAL_OBJECT_ROOT must be the direct data-root child $data_real/objects" >&2
    return 1
  fi
  local parent_real
  parent_real="$(cd "$parent_raw" && pwd -P)" || return 1
  if [ "$parent_real" != "$data_real" ]; then
    echo "ERROR: LOCAL_OBJECT_ROOT must be the direct data-root child $data_real/objects" >&2
    return 1
  fi
  local object_real="$data_real/objects"
  if [ -L "$object_real" ] || { [ -e "$object_real" ] && [ ! -d "$object_real" ]; }; then
    echo "ERROR: local object root is not a real directory: $object_real" >&2
    return 1
  fi
  printf '%s\n' "$object_real"
}

ensure_backup_dir() {
  local data_real="$1"
  local raw_backup_dir="$2"
  require_absolute_path "$raw_backup_dir" "BACKUP_DIR" || return 1
  reject_symlink_components "$raw_backup_dir" || return 1
  if [ "$raw_backup_dir" = "$data_real" ] || [[ "$raw_backup_dir/" == "$data_real/"* ]]; then
    echo "ERROR: BACKUP_DIR may not be the local data root or one of its children" >&2
    return 1
  fi
  if ! mkdir -p "$raw_backup_dir"; then
    echo "ERROR: could not create BACKUP_DIR: $raw_backup_dir" >&2
    return 1
  fi
  reject_symlink_components "$raw_backup_dir" || return 1
  if [ ! -d "$raw_backup_dir" ] || [ -L "$raw_backup_dir" ]; then
    echo "ERROR: BACKUP_DIR is not a real directory: $raw_backup_dir" >&2
    return 1
  fi
  local backup_real
  backup_real="$(cd "$raw_backup_dir" && pwd -P)" || return 1
  reject_dangerous_root "$raw_backup_dir" "$backup_real" || return 1
  if [ "$backup_real" = "$data_real" ] || [[ "$backup_real/" == "$data_real/"* ]]; then
    echo "ERROR: BACKUP_DIR may not be the local data root or one of its children" >&2
    return 1
  fi
  printf '%s\n' "$backup_real"
}

reject_tree_symlinks() {
  local tree_root="$1"
  if [ -L "$tree_root" ]; then
    echo "ERROR: refusing symlinked tree: $tree_root" >&2
    return 1
  fi
  if [ -d "$tree_root" ]; then
    local link
    link="$(find "$tree_root" -type l -print -quit 2>/dev/null || true)"
    if [ -n "$link" ]; then
      echo "ERROR: refusing tree containing a symlink: $link" >&2
      return 1
    fi
  fi
}

validate_archive_members() {
  local archive="$1"
  local expected_top="$2"
  local listing
  local type
  local line
  local member
  local part
  local -a parts
  listing="$(mktemp "${TMPDIR:-/tmp}/infinity-agents-tar.XXXXXX")" || return 1
  if ! tar -tzf "$archive" >"$listing"; then
    rm -f -- "$listing"
    echo "ERROR: object archive could not be listed safely" >&2
    return 1
  fi
  while IFS= read -r member || [ -n "$member" ]; do
    [ -n "$member" ] || continue
    case "$member" in
      /*|*'\'*|*$'\n'*)
        rm -f -- "$listing"
        echo "ERROR: object archive contains an absolute or malformed member" >&2
        return 1
        ;;
    esac
    member="${member%/}"
    case "$member" in
      "$expected_top"|"$expected_top"/*) ;;
      *)
        rm -f -- "$listing"
        echo "ERROR: object archive member is outside $expected_top/: $member" >&2
        return 1
        ;;
    esac
    IFS='/' read -r -a parts <<<"$member"
    for part in "${parts[@]}"; do
      case "$part" in
        ""|.|..)
          rm -f -- "$listing"
          echo "ERROR: object archive contains an unsafe path member: $member" >&2
          return 1
          ;;
      esac
    done
  done <"$listing"
  rm -f -- "$listing"

  listing="$(mktemp "${TMPDIR:-/tmp}/infinity-agents-tar-long.XXXXXX")" || return 1
  if ! tar -tvzf "$archive" >"$listing"; then
    rm -f -- "$listing"
    echo "ERROR: object archive metadata could not be inspected safely" >&2
    return 1
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    type="${line:0:1}"
    case "$type" in
      d|-) ;;
      *)
        rm -f -- "$listing"
        echo "ERROR: object archive contains a non-regular or non-directory entry" >&2
        return 1
        ;;
    esac
  done <"$listing"
  rm -f -- "$listing"
}

extract_object_archive() {
  local archive="$1"
  local data_real="$2"
  local expected_top="objects"
  if ! validate_archive_members "$archive" "$expected_top"; then
    return 1
  fi
  local staging_root
  staging_root="$(mktemp -d "$data_real/.restore-objects.XXXXXX")" || {
    echo "ERROR: could not create a controlled restore directory" >&2
    return 1
  }
  chmod 700 "$staging_root" 2>/dev/null || true
  if ! tar -xzf "$archive" -C "$staging_root"; then
    rm -rf -- "$staging_root"
    echo "ERROR: object archive extraction failed" >&2
    return 1
  fi
  local staged_object="$staging_root/$expected_top"
  if [ ! -d "$staged_object" ] || [ -L "$staged_object" ]; then
    rm -rf -- "$staging_root"
    echo "ERROR: object archive did not produce a real objects directory" >&2
    return 1
  fi
  if ! reject_tree_symlinks "$staged_object"; then
    rm -rf -- "$staging_root"
    return 1
  fi
  printf '%s\n' "$staging_root"
}
