#!/usr/bin/env bash
# Trading scenarios on Base Sepolia, as a market maker or searcher would hit them. Spends ~0.0001 ETH per run.
# A shared Counter contract stands in for a pool: slot 0 is the "price" a quote depends on.
# Usage: K1=./key1 K2=./key2 [COUNTER=0x...] scripts/scenarios-sepolia.sh [1-5 ...]
#   K1 sends the validity txs (needs ~0.5 ETH, only to pass the inventory predicate; it isn't spent).
#   K2 plays the rest of the market (moves the price), any small balance.
set -u
cd "$(dirname "$0")/.."
R=https://sepolia.base.org
K1=${K1:?set K1 to a funded key file}
K2=${K2:?set K2 to a second key file}
export PK="$(cat "$K1")" FORCE_COLOR=${FORCE_COLOR:-1}
[ "$(cast chain-id --rpc-url $R)" = 84532 ] || { echo "not Base Sepolia"; exit 2; }
ME=$(cast wallet address --private-key "$PK")
MKT=$(cast wallet address --private-key "$(cat $K2)")
if [ -z "${COUNTER:-}" ]; then
  COUNTER=$(forge create scripts/Counter.sol:Counter --rpc-url $R --private-key "$PK" --broadcast 2>/dev/null | awk '/Deployed to:/{print $3}')
fi
vtx() { npx tsx src/vtx.ts "$@" || true; }
price() { cast call "$COUNTER" 'n()(uint256)' --rpc-url $R | awk '{print $1}'; }
market() { sleep "$1"; cast send "$COUNTER" "$2" "${@:3}" --rpc-url $R --private-key "$(cat $K2)" --json >/dev/null; }
title() { printf '\n\033[1m━━ %s\033[0m\n%s\n\n' "$1" "$2"; }
FILL=$(cast calldata 'increment()') # the "fill": any call works, predicates decide when it may run

s1() {
  local p=$(price)
  title "1. Backrun a price move" \
"Wait for the pool price to move up from $p, then fill. The market moves it ~2s after we send."
  market 2 'increment()' &
  vtx send --to "$COUNTER" --data "$FILL" --expire 50 \
    -p "storage:$COUNTER:0x0>$p #price moved"
  wait
}

s2() {
  local p=$(price) n=$(cast nonce "$ME" --rpc-url $R)
  title "2. Quote with a 7-link guard chain: the trigger fires, but the price overshoots the band" \
"Fill once the price reaches $((p+5)) (trigger), only if it stays at or under $((p+8)) (band) and
inventory, counterparty, nonce and a packed flag all check out. The market jumps the price to
$((p+20)) ~3s in: the trigger turns true at the same moment the band breaks, so link 6 fails late."
  market 3 'set(uint256)' $((p+20)) &
  vtx send --to "$COUNTER" --data "$FILL" --expire 60 \
    -p "storage:$COUNTER:0x0>=$((p+5)) #trigger: price >= $((p+5))" \
    -p "balance:$ME>=500000000000000000 #inventory >= 0.5 ETH" \
    -p "balance:$MKT>=1000000000000 #counterparty funded" \
    -p "nonce:$ME=$n #no other fill of mine first" \
    -p "storage:$COUNTER:0x0&0xffffffff00000000=0x0 #high bits clear (packed flag)" \
    -p "storage:$COUNTER:0x0<=$((p+8)) #band: price <= $((p+8))"
  wait
}

s3() {
  local p=$(price)
  title "3. Deadline already passed: rejected at submit" \
"A searcher bounds the tx to the next block only. By the time it reaches the sequencer that block is built, so the sequencer rejects it up front."
  vtx send --to "$COUNTER" --data "$FILL" -p "storage:$COUNTER:0x0>=0x0 #always true" -p "block<=$(( $(cast block-number --rpc-url $R) + 1 )) #next block only"
}

s4() {
  local p=$(price) n=$(cast nonce "$ME" --rpc-url $R)
  title "4. Cancel a resting quote" \
"Rest a quote that waits for price >= $((p+100)), then cancel it ~2s later with a plain same-nonce tx and a higher tip."
  ( sleep 2; cast send "$ME" --value 0 --nonce "$n" --priority-gas-price 0.01gwei --gas-price 0.02gwei \
      --rpc-url $R --private-key "$PK" --json >/dev/null ) &
  vtx send --to "$COUNTER" --data "$FILL" --expire 60 -p "storage:$COUNTER:0x0>=$((p+100)) #price >= $((p+100))"
  wait
}

s5() {
  local n=$(cast nonce "$ME" --rpc-url $R)
  title "5. Second leg sent without the first" \
"Leg 2 (nonce $((n+1))) is sent with all predicates true, but leg 1 (nonce $n) never lands."
  vtx send --to "$COUNTER" --data "$FILL" --nonce $((n+1)) --gas 60000 --expire 30 -p "balance:$ME>=1 #funded"
}

echo "sender $ME  market $MKT  pool $COUNTER (price $(price))"
for s in ${*:-1 2 3 4 5}; do "s$s"; done
