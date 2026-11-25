#!/bin/sh
# C6 — a timeout must kill the attempt, not escalate, and leave no orphan.
# The gate sleeps far past the deadline; the attempt is TIMEOUT.
set -eu
DEST=${1:-/tmp/cascade-verify/c6}
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"
git init -q .
cat > gate.sh <<'SH'
#!/bin/sh
sleep 30
exit 0
SH
chmod +x gate.sh
printf 'nothing\n' > placeholder.txt
git add -A
git -c user.name=fixture -c user.email=fixture@local commit -qm base
echo "fixture ready at $DEST"
echo "call: gate=\"sh gate.sh\" expect=\"red\" timeoutMs=2000"
echo "assert: exactly 1 row, outcome=TIMEOUT, no escalation, and pgrep -f cascade-verify/c6 is empty"
