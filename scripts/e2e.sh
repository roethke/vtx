#!/usr/bin/env bash
# End-to-end checks against Vibenet (default) or Base Sepolia. Spends ~0.0001 ETH per run.
# Needs: foundry (cast, forge), K1=path to a funded key file,
# and K2=path to a second key file with any small balance.
# Usage: K1=./key1 K2=./key2 [NET=vibenet|sepolia] scripts/e2e.sh
# Optional: COUNTER=0x... to reuse a deployed scripts/Counter.sol instead of deploying.
# Each case checks the vtx verdict and, independently, the onchain receipt/nonce.
set -u
cd "$(dirname "$0")/.."
NET=${NET:-vibenet}
case $NET in
  vibenet) R=https://rpc.vibes.base.org; SEQ=$R; CHAIN=84538453; FEE=3gwei ;; # base fee ~1 gwei
  sepolia) R=https://sepolia.base.org; SEQ=https://sepolia-sequencer.base.org; CHAIN=84532; FEE=0.02gwei ;;
  *) echo "NET must be vibenet or sepolia"; exit 2 ;;
esac
K1=${K1:?set K1 to a funded key file}
K2=${K2:?set K2 to a second key file}
export PK="$(cat "$K1")"
[ "$(cast chain-id --rpc-url $R)" = $CHAIN ] || { echo "$R is not chain $CHAIN"; exit 2; }
A1=$(cast wallet address --private-key "$(cat $K1)")
A2=$(cast wallet address --private-key "$(cat $K2)")
BIG=1000000000000000000000 # 1000 ETH
vtx() { npx tsx src/vtx.ts "$@" --net $NET || true; } # exit 1 for non-INCLUDED verdicts is expected here
field() { python3 -c "import json,sys; s=json.load(sys.stdin); print(s.get('$1'))"; }
pass=0; fail=0
check() { # name expected actual onchain-ok hash
  if [ "$2" = "$3" ] && [ "$4" = 1 ]; then pass=$((pass+1)); r=PASS; else fail=$((fail+1)); r=FAIL; fi
  printf '%s\t%-28s want %-24s got %-24s onchain=%s %s\n' "$r" "$1" "$2" "$3" "$4" "$5"
}
status_of() { cast rpc eth_getTransactionReceipt "$1" --rpc-url $R 2>/dev/null | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["status"] if r else "none")' 2>/dev/null || echo none; }
run() { local name=$1 want=$2 chk=$3; shift 3; local out h v; out=$(vtx send --json "$@"); h=$(echo "$out" | field hash); v=$(echo "$out" | field verdict)
  local st; st=$(status_of "$h"); local ok=0
  case $chk in success) [ "$st" = 0x1 ] && ok=1;; reverted) [ "$st" = 0x0 ] && ok=1;; none) [ "$st" = none ] && ok=1;; esac
  check "$name" "$want" "$v" $ok "$h"; }

if [ -z "${COUNTER:-}" ]; then
  COUNTER=$(forge create scripts/Counter.sol:Counter --rpc-url $R --private-key "$(cat $K1)" --broadcast 2>/dev/null | awk '/Deployed to:/{print $3}')
fi
echo "counter $COUNTER, sender $A1, helper $A2"
k2() { cast send "$@" --rpc-url $R --private-key "$(cat $K2)" --json >/dev/null; }

run always-true INCLUDED success -p "balance:$A1>=1"
run never-true EXPIRED_PREDICATE_FALSE none --expire 10 -p "balance:$A1>=$BIG"
run plain INCLUDED success --plain
run revert INCLUDED_REVERTED reverted --to "$COUNTER" --data "$(cast sig 'boom()')" --gas 60000 -p "balance:$A1>=1"

# storage mask: slot0 = 0x1ff, so slot0 & 0xff00 = 0x100
k2 "$COUNTER" 'set(uint256)' 0x1ff
run mask-true INCLUDED success --expire 15 -p "storage:$COUNTER:0x0&0xff00=0x100"
run mask-false EXPIRED_PREDICATE_FALSE none --expire 10 -p "storage:$COUNTER:0x0&0xff00=0x200"
run mask-bits-outside REJECTED none -p "storage:$COUNTER:0x0&0xff>=0x100"

# false-then-true: gate on slot0 >= current+1, then increment from the helper account
cur=$(cast to-dec "$(cast storage "$COUNTER" 0 --rpc-url $R)")
out=/tmp/vtx-e2e-flip.json; vtx send --json --expire 150 -p "storage:$COUNTER:0x0>=$((cur+1))" > $out & pid=$!
sleep 3; k2 "$COUNTER" 'increment()'; wait $pid
h=$(field hash < $out); v=$(field verdict < $out); ok=0; [ "$(status_of "$h")" = 0x1 ] && ok=1
fails=$(python3 -c "import json; s=json.load(open('$out')); print(sum(1 for b in s['blocks'] if not b['predicates'][0]['ok']))")
[ "$fails" -gt 0 ] || ok=0 # must have seen at least one ✗ block before the flip
check storage-flip INCLUDED "$v" $ok "$h"

# nonce predicate on the helper account
n=$(cast nonce "$A2" --rpc-url $R)
out=/tmp/vtx-e2e-nonce.json; vtx send --json --expire 150 -p "nonce:$A2>=$((n+1))" > $out & pid=$!
sleep 3; k2 "$A2" --value 0; wait $pid
h=$(field hash < $out); v=$(field verdict < $out); ok=0; [ "$(status_of "$h")" = 0x1 ] && ok=1
check nonce-flip INCLUDED "$v" $ok "$h"

# replacement: never-true vtx, then a plain tx with the same nonce and a higher fee
N=$(cast nonce "$A1" --rpc-url $R)
h=$(vtx send --json --no-track --expire 50 -p "balance:$A1>=$BIG" | field hash)
cast send "$A1" --value 0 --nonce "$N" --priority-gas-price 0.01gwei --gas-price $FEE --rpc-url $R --private-key "$(cat $K1)" --json >/dev/null
v=$(vtx track "$h" --json | field verdict); ok=0; [ "$(status_of "$h")" = none ] && [ "$(cast nonce "$A1" --rpc-url $R)" -gt "$N" ] && ok=1
check replaced REPLACED "$v" $ok "$h"

# nonce gap on the helper account: tx nonce n+1 while n is unused
n=$(cast nonce "$A2" --rpc-url $R)
run nonce-gap EXPIRED_NONCE_GAP none --key-file $K2 --nonce $((n+1)) --gas 21000 --expire 15 -p "balance:$A2>=1"

# rejections
head=$(cast block-number --rpc-url $R)
# Sepolia rejects flashblock_index since Denim; Vibenet still accepts it at submission, so only Sepolia checks it
[ $NET = sepolia ] && run reject-flashblock REJECTED none --validity "[{\"type\":\"flashblock_index\",\"params\":{\"op\":\"<=\",\"value\":\"0x3\"}}]"
run reject-far-expiry REJECTED none -p "block<=$((head+1000))"
# a lower bound alone: vtx adds its own upper bound (expiry), so the sequencer accepts it
run lower-only-expiry INCLUDED success -p "block>=1"
run reject-bad-op REJECTED none --validity "[{\"type\":\"balance\",\"params\":{\"address\":\"$A1\",\"op\":\"=>\",\"value\":\"0x1\"}},{\"type\":\"block_number\",\"params\":{\"op\":\"<=\",\"value\":\"$(cast to-hex $((head+40)))\"}}]"

# track --body for a tx sent outside vtx
head=$(cast block-number --rpc-url $R); N=$(cast nonce "$A1" --rpc-url $R --block pending)
raw=$(cast mktx "$A1" --value 0 --nonce "$N" --gas-limit 21000 --priority-gas-price 0.001gwei --gas-price $FEE --chain $CHAIN --rpc-url $R --private-key "$(cat $K1)")
body=/tmp/vtx-e2e-body.json
echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"base_sendRawTransactionValidity\",\"params\":[\"$raw\",{\"validity\":[{\"type\":\"balance\",\"params\":{\"address\":\"$A1\",\"op\":\">=\",\"value\":\"0x1\"}},{\"type\":\"block_number\",\"params\":{\"op\":\"<=\",\"value\":\"$(cast to-hex $((head+40)))\"}}]}]}" > $body
h=$(curl -s -X POST $SEQ -H 'content-type: application/json' -d @$body | field result)
v=$(vtx track "$h" --body $body --json | field verdict); ok=0; [ "$(status_of "$h")" = 0x1 ] && ok=1
check track-body INCLUDED "$v" $ok "$h"

# timeout: tracking stops before the tx can expire
run timeout TIMEOUT none --timeout 2 --expire 100 -p "balance:$A1>=$BIG"

echo "pass $pass fail $fail"
[ "$fail" = 0 ]
