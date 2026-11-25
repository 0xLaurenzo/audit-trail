#!/usr/bin/env bash
# Exercise the npm release outside the checkout, without dev or optional peers.
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# A pre-existing output path belongs to the caller, not the pack lifecycle.
mkdir -p "$tmp/collision/dist" "$tmp/rejected"
cp package.json "$tmp/collision/"
cp -R bin src "$tmp/collision/"
mkdir -p "$tmp/collision/dist/cli"
printf 'throw new Error("stale build ran");\n' > "$tmp/collision/dist/cli/bin.js"
printf 'unrelated local bytes\n' > "$tmp/expected"
cp "$tmp/expected" "$tmp/collision/dist/preexisting-file.txt"
(
    cd "$tmp/collision"
    ./bin/audit-trail help > /dev/null
    if npm pack --pack-destination "$tmp/rejected" >"$tmp/pack.log" 2>&1; then exit 1; fi
    grep -q EEXIST "$tmp/pack.log"
    cmp dist/preexisting-file.txt "$tmp/expected"
    npm run postpack --silent
    cmp dist/preexisting-file.txt "$tmp/expected"
)
test -z "$(ls -A "$tmp/rejected")"

archive=$(npm pack --silent --pack-destination "$tmp")
test ! -e dist
cd "$tmp"
npm install --no-audit --no-fund --omit=dev --omit=optional "./$archive"
pkg=node_modules/pi-audit-trail
test ! -e "$pkg/src/cli/bin.ts"
test -f "$pkg/dist/cli/bin.js"
for asset in src/core/workflow.ts src/mcp/server.ts src/adapters/{pi,opencode}.ts \
    .{claude,codex}-plugin/plugin.json .mcp.json claude/{hooks,mcp}.json \
    hooks/hooks.json skills/audit-trail/SKILL.md; do
    test -f "$pkg/$asset"
done
export HOME="$tmp/home"
bin=node_modules/.bin/audit-trail
"$bin" install pi
"$bin" install opencode
"$bin" uninstall pi
"$bin" uninstall opencode
"$bin" -C "$tmp" start package-smoke
test -f .audit/package-smoke.tsv
