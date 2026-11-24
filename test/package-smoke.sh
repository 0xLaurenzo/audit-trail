#!/usr/bin/env bash
# Exercise the npm release outside the checkout, without dev or optional peers.
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
archive=$(npm pack --silent --pack-destination "$tmp")
cd "$tmp"
npm install --no-audit --no-fund --omit=dev --omit=optional "./$archive"
pkg=node_modules/pi-audit-trail
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
