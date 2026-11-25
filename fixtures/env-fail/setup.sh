#!/bin/sh
# C5 — an environment failure must not burn the escalation rungs.
# The gate always reports ECONNREFUSED and exits 1, so the attempt is ENV_FAIL.
set -eu
DEST=${1:-/tmp/cascade-verify/c5}
rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"
git init -q .
cat > gate.sh <<'SH'
#!/bin/sh
echo "Error: connect ECONNREFUSED 127.0.0.1:5432" >&2
exit 1
SH
chmod +x gate.sh
printf 'nothing\n' > placeholder.txt
git add -A
git -c user.name=fixture -c user.email=fixture@local commit -qm base
echo "fixture ready at $DEST"
echo "call: gate=\"sh gate.sh\" expect=\"red\""
echo "assert: exactly 1 row, outcome=ENV_FAIL, escalatedTo=null, no second tier attempted"
