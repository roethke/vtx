#!/usr/bin/env bash
# Trading scenarios on Vibenet (default) or Base Sepolia, as a market maker or searcher would hit them.
# Spends ~0.0001 ETH per run on Sepolia, ~0.002 ETH on Vibenet (base fee ~1 gwei).
# A shared Counter contract stands in for a pool: slot 0 is the "price" a quote depends on.
# Usage: scripts/scenarios.sh --dry-run [1-5 ...]        preview: no keys, no network, nothing sent
#        K1=./key1 K2=./key2 [NET=vibenet|sepolia] [COUNTER=0x...] scripts/scenarios.sh [1-5 ...]
#   --dry-run prints each scenario, the vtx command it runs, and the output of a recorded run.
#   K1 sends the validity txs (needs the inventory amount: 0.05 ETH on Vibenet, 0.5 ETH on Sepolia; it isn't spent).
#   K2 plays the rest of the market (moves the price), any small balance.
#   RECORD=1 saves each vtx output to scripts/scenarios/N.txt, with addresses replaced by names.
set -u
DRY=; [ "${1:-}" = --dry-run ] && { DRY=1; shift; }
cd "$(dirname "$0")/.."
NET=${NET:-vibenet}
case $NET in
  vibenet) R=https://rpc.vibes.base.org; CHAIN=84538453; FEE=3gwei; INV=50000000000000000; INV_ETH=0.05 ;;
  sepolia) R=https://sepolia.base.org; CHAIN=84532; FEE=0.02gwei; INV=500000000000000000; INV_ETH=0.5 ;;
  *) echo "NET must be vibenet or sepolia"; exit 2 ;;
esac
export FORCE_COLOR=${FORCE_COLOR:-1}
title() { printf '\n\033[1m━━ %s\033[0m\n%s\n\n' "$1" "$2"; }

if [ -n "$DRY" ]; then
  ME=0xYOU MKT=0xMARKET COUNTER=0xPOOL FILL=0xd09de08a
  price() { echo 500; }
  nonce() { echo N; }
  head_block() { echo HEAD; }
  add() { [ "$1" = N ] || [ "$1" = HEAD ] && echo "$1+$2" || echo $(($1 + $2)); }
  market() { printf '  \033[2m(after %ss the market calls %s on the pool)\033[0m\n' "$1" "${*:2}"; }
  cancel() { printf '  \033[2m(after 2s you send a plain self-transfer with nonce %s and a 10x tip)\033[0m\n' "$1"; }
  vtx() {
    # One -p per line, single-quoted, as you'd type it.
    local out="  \033[2m\$\033[0m vtx" a
    while [ $# -gt 0 ]; do
      a=$1; shift
      if [ "$a" = -p ]; then out+=" \\\\\n      -p '$1'"; shift; else out+=" $a"; fi
    done
    printf "$out\n"
    local f=scripts/scenarios/$S.txt
    [ -f "$f" ] && { printf '\n  \033[2mrecorded run on Base Sepolia (its prices and blocks differ from the preview numbers):\033[0m\n\n'; sed 's/^/  │ /' "$f"; }
  }
  wait() { :; }
else
  K1=${K1:?set K1 to a funded key file (or pass --dry-run to preview)}
  K2=${K2:?set K2 to a second key file}
  export PK="$(cat "$K1")"
  [ "$(cast chain-id --rpc-url $R)" = $CHAIN ] || { echo "RPC is not $NET"; exit 2; }
  ME=$(cast wallet address --private-key "$PK")
  MKT=$(cast wallet address --private-key "$(cat $K2)")
  [ -n "${COUNTER:-}" ] || COUNTER=$(forge create scripts/Counter.sol:Counter --rpc-url $R --private-key "$PK" --broadcast 2>/dev/null | awk '/Deployed to:/{print $3}')
  FILL=$(cast calldata 'increment()') # the "fill": any call works, predicates decide when it may run
  price() { cast call "$COUNTER" 'n()(uint256)' --rpc-url $R | awk '{print $1}'; }
  nonce() { cast nonce "$ME" --rpc-url $R; }
  head_block() { cast block-number --rpc-url $R; }
  add() { echo $(($1 + $2)); }
  market() { sleep "$1"; cast send "$COUNTER" "$2" "${@:3}" --rpc-url $R --private-key "$(cat $K2)" --json >/dev/null; }
  cancel() { sleep 2; cast send "$ME" --value 0 --nonce "$1" --priority-gas-price 0.01gwei --gas-price $FEE --rpc-url $R --private-key "$PK" --json >/dev/null; }
  # Replace addresses (full and shortened) with names so recordings carry no wallet details.
  redact() {
    local s=""
    for pair in "$ME:0xYOU" "$MKT:0xMARKET" "$COUNTER:0xPOOL"; do
      local a=${pair%%:*} n=${pair#*:}
      s+="s/$a/$n/Ig;s/${a:0:10}…${a: -4}/$n/Ig;"
    done
    sed -E "$s"'s/(0x[0-9a-f]{8})[0-9a-f]{52}([0-9a-f]{4})/\1…\2/g'
  }
  vtx() {
    if [ -n "${RECORD:-}" ]; then mkdir -p scripts/scenarios; npx tsx src/vtx.ts "$@" --net $NET | tee >(redact > scripts/scenarios/$S.txt) || true
    else npx tsx src/vtx.ts "$@" --net $NET || true; fi
  }
fi

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
  local p=$(price) n=$(nonce)
  title "2. Quote with a 7-link guard chain: the trigger fires, but the price overshoots the band" \
"Fill once the price reaches $(add $p 5) (trigger), only if it stays at or under $(add $p 8) (band) and
inventory, counterparty, nonce and a packed flag all check out. The market jumps the price to
$(add $p 20) ~3s in: the trigger turns true at the same moment the band breaks, so link 6 fails late."
  market 3 'set(uint256)' $(add $p 20) &
  vtx send --to "$COUNTER" --data "$FILL" --expire 60 \
    -p "storage:$COUNTER:0x0>=$(add $p 5) #trigger: price >= $(add $p 5)" \
    -p "balance:$ME>=$INV #inventory >= $INV_ETH ETH" \
    -p "balance:$MKT>=1000000000000 #counterparty funded" \
    -p "nonce:$ME=$n #no other fill of mine first" \
    -p "storage:$COUNTER:0x0&0xffffffff00000000=0x0 #high bits clear (packed flag)" \
    -p "storage:$COUNTER:0x0<=$(add $p 8) #band: price <= $(add $p 8)"
  wait
}

s3() {
  title "3. Deadline already passed: rejected at submit" \
"A searcher bounds the tx to the next block only. By the time it reaches the sequencer that block is built, so the sequencer rejects it up front."
  vtx send --to "$COUNTER" --data "$FILL" -p "storage:$COUNTER:0x0>=0x0 #always true" -p "block<=$(add $(head_block) 1) #next block only"
}

s4() {
  local p=$(price) n=$(nonce)
  title "4. Cancel a resting quote" \
"Rest a quote that waits for price >= $(add $p 100), then cancel it ~2s later with a plain same-nonce tx and a higher tip."
  cancel "$n" &
  vtx send --to "$COUNTER" --data "$FILL" --expire 60 -p "storage:$COUNTER:0x0>=$(add $p 100) #price >= $(add $p 100)"
  wait
}

s5() {
  local n=$(nonce)
  title "5. Second leg sent without the first" \
"Leg 2 (nonce $(add $n 1)) is sent with all predicates true, but leg 1 (nonce $n) never lands."
  vtx send --to "$COUNTER" --data "$FILL" --nonce $(add $n 1) --gas 60000 --expire 30 -p "balance:$ME>=1 #funded"
}

[ -n "$DRY" ] && echo "preview: nothing is sent. 0xYOU = your key, 0xMARKET = a second key, 0xPOOL = the Counter contract (price 500)" \
  || echo "sender $ME  market $MKT  pool $COUNTER (price $(price))"
for S in ${*:-1 2 3 4 5}; do "s$S"; done
