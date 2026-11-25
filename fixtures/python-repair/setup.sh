#!/bin/sh
# C2 — Python, T0-repair path.
# The gate needs THREE host runs before it is green, which forces
# t0 CAPABILITY_FAIL -> t0-repair PASS. It is three, not two, because the
# baseline check at HEAD is itself a host run (verified: a "needs two" gate let
# t0 pass on its first attempt and the fixture lied).
# The PI_CASCADE_GATE guard stops a child's own gate run from advancing the
# counter — without it the repair rung passes and the fixture lies.
set -eu
DEST=${1:-/tmp/cascade-verify/c2}
COUNTER=/tmp/cascade-verify/c2-counter
rm -rf "$DEST" "$COUNTER"
mkdir -p "$DEST"
cd "$DEST"
git init -q .
printf '__pycache__/\n*.pyc\n.counter\n' > .gitignore
cat > calc.py <<'PY'
def double(n):
    return n + n - 1
PY
cat > test_calc.py <<'PY'
import unittest
from calc import double


class CalcTest(unittest.TestCase):
    def test_double(self):
        self.assertEqual(double(2), 4)


if __name__ == "__main__":
    unittest.main()
PY
cat > gate.sh <<'SH'
#!/bin/sh
# Only a host run counts: a child checking its own work must not advance this.
[ "$PI_CASCADE_GATE" = "1" ] || exit 0
n=$(cat /tmp/cascade-verify/c2-counter 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > /tmp/cascade-verify/c2-counter
[ "$n" -ge 3 ] || { echo "host run $n: gate not satisfied yet"; exit 1; }
python3 -m unittest -q
SH
chmod +x gate.sh
git add -A
git -c user.name=fixture -c user.email=fixture@local commit -qm base
echo "fixture ready at $DEST"
echo "call: gate=\"sh gate.sh\" expect=\"red\""
echo "assert: exactly 2 rows (t0 at host run 2, t0-repair at host run 3) — t0 CAPABILITY_FAIL, t0-repair PASS — with the total cost recorded"
