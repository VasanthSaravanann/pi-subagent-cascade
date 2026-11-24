#!/bin/sh
# C1 — Rust, T0 first pass.
# Builds a throwaway repo at /tmp/cascade-verify/c1 whose gate is red at HEAD,
# so the cascade must be called with expect="red".
set -eu
DEST=${1:-/tmp/cascade-verify/c1}
rm -rf "$DEST"
mkdir -p "$DEST/src"
cd "$DEST"
git init -q .
printf '/target\nCargo.lock\n' > .gitignore
cat > Cargo.toml <<'TOML'
[package]
name = "c1"
version = "0.1.0"
edition = "2021"
TOML
cat > src/lib.rs <<'RS'
pub fn add(a: i32, b: i32) -> i32 {
    a - b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds() {
        assert_eq!(add(1, 1), 2);
    }
}
RS
git add -A
git -c user.name=fixture -c user.email=fixture@local commit -qm base
echo "fixture ready at $DEST"
echo "call: gate=\"cargo test --quiet\" expect=\"red\""
echo "assert: exactly 1 ledger row, tier=t0, outcome=PASS, costUsd>0; patch applies and cargo test is green"
