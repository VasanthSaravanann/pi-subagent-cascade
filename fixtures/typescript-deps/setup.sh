#!/bin/sh
# C3 — TypeScript with a real `node_modules`, gate `npm test`.
# Proven deps inside the attempt worktree: the worktree starts empty except for
# tracked files, so without the B5 symlink the gate dies with MODULE_NOT_FOUND.
# Deps are installed into the fixture repo and gitignored, which is exactly the
# "gitignored files are not carried over" case the symlink support exists for.
set -eu
DEST=${1:-/tmp/cascade-verify/c3}
rm -rf "$DEST"
mkdir -p "$DEST/src"
cd "$DEST"
git init -q .
printf 'node_modules/\n' > .gitignore
cat > package.json <<'JSON'
{
  "name": "c3-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > src/math.js <<'JS'
export const add = (a, b) => a + b;
JS
cat > src/math.test.js <<'JS'
import test from "node:test";
import assert from "node:assert";
import { add } from "./math.js";
import { pad } from "leftpad-lite";

test("adds", () => {
  assert.equal(add(2, 3), 5);
});

test("resolves the gitignored dependency", () => {
  // Without the B5 symlink this is ERR_MODULE_NOT_FOUND inside the worktree.
  assert.equal(pad("x", 3), "  x");
});
JS
git add -A
git -c user.name=fixture -c user.email=fixture@local commit -qm base
# A dependency that only exists on disk, never in git.
mkdir -p node_modules/leftpad-lite
printf '{"name":"leftpad-lite","version":"1.0.0","type":"module","main":"index.js"}\n' > node_modules/leftpad-lite/package.json
printf 'export const pad = (s, n) => String(s).padStart(n, " ");\n' > node_modules/leftpad-lite/index.js
echo "fixture ready at $DEST (node_modules present, gitignored, gate green at HEAD)"
echo "call: gate=\"npm test\" expect=\"green\""
echo "assert: PASS on t0 or t0-repair, and no MODULE_NOT_FOUND in the gate output"
