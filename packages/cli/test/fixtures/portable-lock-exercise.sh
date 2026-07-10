#!/usr/bin/env bash
# Exercise the portable hook mutex in common.sh with flock forced OFF, the way
# Git Bash on Windows (and stock macOS without `brew install flock`) sees it.
# Proves the Bug #2 guarantee from the 2026-07-10 Windows prod incident
# (notes/20260710-windows-hook-wiring-and-portable-lock-fix.md): a missing flock
# must NOT abort the hook; the mkdir(2) fallback must still give mutual exclusion,
# atomic appends, correct trylock busy/free, and stale-holder reaping.
#
# Driven by test/hooks/portable-lock-fallback.spec.ts. That spec sources this with
# an isolated MEETLESS_HOME and COMMON_SH pointing at the real src helper (never a
# re-implementation), then asserts exit 0. Any drift that reintroduces a flock
# dependency, a torn append, or a deadlock fails here.
#
# Env in: COMMON_SH (path to src/hooks-template/common.sh), MEETLESS_HOME (isolated).
set -uo pipefail

# Source the REAL helpers. common.sh re-enables `set -e`; drop it for the harness
# so a single failed check does not abort the whole exercise before we tally.
# shellcheck disable=SC1090
source "$COMMON_SH" >/dev/null 2>&1
set +e
MEETLESS_HAVE_FLOCK=0   # force the mkdir(2) path (simulate Windows / no-brew macOS)

SCRATCH="$(mktemp -d)"
LOCK="$QUEUE_DIR/stress.lock"
FAILS=0

# --- Test 1: mutual exclusion via a shared in-critical-section counter ---------
CTR="$SCRATCH/ctr"; echo 0 > "$CTR"
VIOL="$SCRATCH/violations"; : > "$VIOL"
worker_mx() {
  local i="$1"
  for _ in 1 2 3 4 5; do
    ml_lock 9 "$LOCK"
    local c; c=$(<"$CTR"); c=$((c + 1)); echo "$c" > "$CTR"
    [[ "$c" == "1" ]] || echo "saw $c concurrent holders (worker $i)" >> "$VIOL"
    sleep 0.01   # widen the window so a broken lock would overlap observably
    c=$(<"$CTR"); c=$((c - 1)); echo "$c" > "$CTR"
    ml_unlock 9 "$LOCK"
  done
}
for i in $(seq 1 12); do worker_mx "$i" & done
wait
if [[ -s "$VIOL" ]]; then
  echo "FAIL mutual-exclusion:"; cat "$VIOL"; FAILS=$((FAILS + 1))
else
  echo "PASS mutual-exclusion (12 workers x 5 rounds, counter never exceeded 1)"
fi

# --- Test 2: append atomicity (no lost / torn lines) ---------------------------
OUT="$SCRATCH/appends.jsonl"; : > "$OUT"
NW=10; NL=50
worker_ap() {
  local i="$1"
  for n in $(seq 1 "$NL"); do
    ml_lock 9 "$LOCK"
    printf 'worker-%02d line-%03d\n' "$i" "$n" >> "$OUT"
    ml_unlock 9 "$LOCK"
  done
}
for i in $(seq 1 "$NW"); do worker_ap "$i" & done
wait
GOT=$(wc -l < "$OUT" | tr -d ' ')
WANT=$((NW * NL))
DISTINCT=$(sort -u "$OUT" | wc -l | tr -d ' ')
TORN=$(grep -cvE '^worker-[0-9]{2} line-[0-9]{3}$' "$OUT")
if [[ "$GOT" == "$WANT" && "$DISTINCT" == "$WANT" && "$TORN" == "0" ]]; then
  echo "PASS append-atomicity ($GOT/$WANT lines, all distinct, 0 torn)"
else
  echo "FAIL append-atomicity: got=$GOT want=$WANT distinct=$DISTINCT torn=$TORN"; FAILS=$((FAILS + 1))
fi

# --- Test 3: trylock busy/free -------------------------------------------------
TL="$QUEUE_DIR/try.lock"
ml_lock 9 "$TL"
if ml_trylock 8 "$TL"; then
  echo "FAIL trylock: acquired a held lock"; FAILS=$((FAILS + 1)); ml_unlock 8 "$TL"
else
  echo "PASS trylock: refused a held lock"
fi
ml_unlock 9 "$TL"
if ml_trylock 8 "$TL"; then
  echo "PASS trylock: acquired a free lock"; ml_unlock 8 "$TL"
else
  echo "FAIL trylock: refused a free lock"; FAILS=$((FAILS + 1))
fi

# --- Test 4: stale-holder reap (crashed holder never released) -----------------
# A holder that dies mid-section leaves the lock dir behind. Backdate its mtime
# past the 2-min TTL and confirm the next acquirer reclaims it instead of blocking
# forever (the deadlock the flock kernel-release used to prevent for free).
SL="$QUEUE_DIR/stale.lock"
mkdir "$SL.d"
touch -mt 202001010000 "$SL.d"
if ml_trylock 9 "$SL"; then
  echo "PASS stale-reap: reclaimed a dead holder's lock"; ml_unlock 9 "$SL"
else
  echo "FAIL stale-reap: could not reclaim a stale lock"; FAILS=$((FAILS + 1))
fi

echo "----"
if [[ "$FAILS" == "0" ]]; then echo "ALL LOCK TESTS PASSED"; else echo "$FAILS TEST GROUP(S) FAILED"; fi
rm -rf "$SCRATCH"
exit "$FAILS"
