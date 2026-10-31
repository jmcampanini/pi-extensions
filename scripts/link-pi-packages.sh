#!/bin/sh
# Pi supplies these packages to extensions at runtime, so they are peerDependencies here.
# For local typechecking and tests, link them from the installed Pi instead of installing copies.
set -eu
find_root() {
  dir="$1"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/package.json" ] && grep -q '"name": "@earendil-works/pi-coding-agent"' "$dir/package.json"; then
      echo "$dir"; return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}
pi_root="${PI_PACKAGE_ROOT:-}"
if [ -z "$pi_root" ]; then
  for candidate in "$HOME/.local/bin/pi" "$(command -v pi || true)"; do
    [ -n "$candidate" ] || continue
    resolved="$(readlink -f "$candidate" 2>/dev/null || true)"
    [ -n "$resolved" ] || continue
    pi_root="$(find_root "$(dirname "$resolved")" || true)"
    [ -n "$pi_root" ] && break
  done
fi
[ -n "$pi_root" ] || { echo "cannot find the installed @earendil-works/pi-coding-agent; set PI_PACKAGE_ROOT" >&2; exit 1; }
mkdir -p node_modules/@earendil-works
ln -sfn "$pi_root" node_modules/@earendil-works/pi-coding-agent
for pkg in pi-ai pi-agent-core pi-tui; do
  ln -sfn "$pi_root/node_modules/@earendil-works/$pkg" "node_modules/@earendil-works/$pkg"
done
ln -sfn "$pi_root/node_modules/typebox" node_modules/typebox
echo "linked Pi packages from $pi_root"
