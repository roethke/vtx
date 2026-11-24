#!/usr/bin/env bash
# Paired validity vs plain sends on Vibenet (default) or Base Sepolia: N pairs per tip, random send offset within the 200ms block.
# Usage: K1=./key [NET=vibenet|sepolia] scripts/compare.sh [pairs] [tips...]   eg, K1=./key scripts/compare.sh 10 0.0001 0.001 0.01
# Prints one TSV row per tx: tip mode hash verdict blocksToInclusion blocksAfterArrival
set -euo pipefail
cd "$(dirname "$0")/.."
N=${1:-10}; shift || true
TIPS=${*:-0.0001 0.001 0.01}
K1=${K1:?set K1 to a funded key file}
NET=${NET:-vibenet}
export PK="$(cat "$K1")"
ADDR=$(cast wallet address --private-key "$PK")
row() { python3 -c '
import json,sys
s=json.load(sys.stdin); b=s["blocks"]
arr=next((r["block"] for r in b if r["arrived"]),None)
after=s["includedBlock"]-arr if s["includedBlock"] and arr else ""
print("\t".join(map(str,[sys.argv[1],sys.argv[2],s["hash"],s["verdict"],s["blocksToInclusion"] if s["blocksToInclusion"] is not None else "",after])))' "$@"; }
printf 'tip\tmode\thash\tverdict\tblocks\tafterArrival\n'
for tip in $TIPS; do
  for i in $(seq 1 "$N"); do
    for mode in validity plain; do
      sleep "0.$((RANDOM % 200 + 100))"
      if [ $mode = plain ]; then out=$(npx tsx src/vtx.ts send --net $NET --json --plain --tip "$tip" --timeout 30 || true)
      else out=$(npx tsx src/vtx.ts send --net $NET --json --tip "$tip" --timeout 30 -p "balance:$ADDR>=1" || true); fi
      echo "$out" | row "$tip" "$mode"
    done
  done
done
