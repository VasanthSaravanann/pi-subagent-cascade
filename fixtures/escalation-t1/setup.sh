#!/bin/sh
# C4 — escalation to T1.
# The gate needs FOUR host runs before it is green: baseline (1), t0 (2),
# t0-repair (3), t1 (4). So the only way to pass is on the frontier tier.
# PI_CASCADE_GATE keeps a child's own gate run from advancing the counter —
# without that guard this fixture lies and t0-repair passes.
set -eu
DEST=${1:-/tmp/cascade-verify/c4}
COUNTER=/tmp/cascade-verify/c4-counter
rm -rf "$DEST" "$COUNTER"
mkdir -p "$DEST"
cd "$DEST"
git init -q .
printf '*.tmp\n' > .gitignore
cat > counter.txt <<'TXT'
0
TXT
cat > gate.sh <<'SH'
#!/bin/sh
# Only a host run counts: a child checking its own work must not advance this.
[ "$PI_CASCADE_GATE" = "1" ] || exit 0
n=$(cat /tmp/cascade-verify/c4-counter 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > /tmp/cascade-verify/c4-counter
echo "host gate run $n of 4"
[ "$n" -ge 4 ]
SH
chmod +x gate.sh
cat > NOTES.md <<'MD'
scratch
MD
git add -A
git -c user.name=fixture -c user.email=fixture@local commit -qm base
echo "fixture ready at $DEST"
echo "call: gate=\"sh gate.sh\" expect=\"red\" (default tiers)"
echo "task: a TRIVIAL edit (append a line to NOTES.md) — a reasoning-heavy task makes"
echo "      T1 hit the per-attempt deadline and turn into TIMEOUT, which never escalates"
echo "assert: exactly 3 rows — t0 CAPABILITY_FAIL, t0-repair CAPABILITY_FAIL, t1 PASS"
echo "assert: t1 model is opencode-go/deepseek-v4-pro and the t1 row is ~\$0.027 (abort if > \$0.10)"
echo "assert: the t1 row is NOT kimi-k3 — that would mean the default regressed"
