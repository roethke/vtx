# vtx

Send and track Base validity transactions block by block, and see which predicate held you back.

Predicates are offchain, so no public endpoint can explain a missed validity tx from its hash alone. `vtx` records the predicates when it sends, then re-reads the state each predicate watches at every block until the tx lands, expires, or is replaced.

## Install

Needs Node 20 or later.

```bash
npm install -g github:roethke/vtx
vtx --help
```

From a clone: `npm install && npm link`, or run without installing via `npx tsx src/vtx.ts`.

## Send and track

```bash
# Sepolia self-transfer, held until the sender's balance is at least 0.01 ETH, expires 50 blocks out
vtx send --net sepolia -p 'balance:0xYourAddr>=10000000000000000'

# Storage predicate with a mask, explicit expiry
vtx send -p 'storage:0xPool:0x0&0xff<=0x2a' -p 'block<=41203200'

# Control group: same tx as a plain eth_sendRawTransaction
vtx send --plain
```

Key: `--key-file PATH` (a file holding the hex private key) or the `PK` env var. `--key-file` wins when both are set. Default network is `sepolia`; pass `--net mainnet` for mainnet.

Label predicates with ` #name` (local only, never sent) so the output names each link of a long chain:

```bash
vtx send --to 0xPool --data 0x... \
  -p 'storage:0xPool:0x0>=539 #trigger' \
  -p 'balance:0xYourAddr>=500000000000000000 #inventory' \
  -p 'storage:0xPool:0x0<=542 #band'
```

Output for a tx that expired because the price overshot its band:

```
block 60976148  1✓ 2✓ 3✗ 4✓  #3 band: 554, want <= 542  [min tip 0.001]
  ⋮ same for 29 more blocks (through 60976177)

EXPIRED_PREDICATE_FALSE: expired after block 60976178. After the tx reached the sequencer, its
predicates were never all true in the same block. The one that kept it out: #3 band (last value 554)

predicate chain (53 blocks after arrival; all held together in 0)
  #  name       held   first ✗   last value vs target
  1  trigger    31/53  60976126  554 vs >= 539
  2  inventory  53/53  -         0.99 ETH vs >= 0.5 ETH
  3  band       22/53  60976148  554 vs <= 542
  4  expiry     53/53  -         60976178 vs <= 60976178
```

Output is colored on a terminal; `NO_COLOR=1` turns it off, `FORCE_COLOR=1` keeps it when piping.

## Track a tx you sent elsewhere

```bash
vtx track 0xHASH --net mainnet --body request.json
```

`request.json` is the JSON-RPC body (or its `params` array) you posted to `base_sendRawTransactionValidity`. vtx checks that the raw tx hashes to `0xHASH`.

Without a send record, replay starts at the inclusion block if the tx landed, or at the 60s window before expiry if it already expired. The send time is unknown, so blocks before you submitted count as eligible: pass `--from N` (the head block when you sent) to start there.

`VTX_RPC=https://your-node` overrides the read RPC. Exit code is 0 for `INCLUDED`, 1 for any other verdict, 2 for usage errors.

## Verdicts

| Verdict | Meaning |
|---|---|
| `INCLUDED` | Landed and succeeded. Notes when the predicates were false at block start and a tx earlier in the same block made them true |
| `INCLUDED_REVERTED` | Landed, predicates passed, execution reverted |
| `EXPIRED_PREDICATE_FALSE` | Expired; at least one predicate never held. Lists the last failing predicate and its actual value |
| `EXPIRED_WHILE_ELIGIBLE` | Expired although every predicate held for N blocks after arrival. Flags blocks where max fee < base fee or tip < lowest included tip; otherwise says public data doesn't explain the miss |
| `EXPIRED_NONCE_GAP` | Predicates held, but an earlier sender nonce never landed, so the tx could not execute |
| `EXPIRED_BEFORE_ARRIVAL` | Every block up to expiry started building before the tx reached the sequencer |
| `REPLACED` | Another tx used the same sender nonce (named when it's in the replayed range) |
| `DROPPED` | Sequencer reported `Unknown` before expiry (mainnet only: `base_transactionStatus` isn't open on Sepolia) |
| `REJECTED` | The submit call returned an error |
| `TIMEOUT` | Still pending when tracking stopped |

`--json` prints one JSON object: verdict, sent/expiry/included blocks, per-reason eligible-block counts, last failing predicates, and per-block predicate results.

## Tests

`K1=./key1 K2=./key2 scripts/e2e-sepolia.sh` runs every verdict on Base Sepolia and checks each against the onchain receipt and nonce (~17 cases, ~5 min; K2 needs only a small balance). `K1=./key1 scripts/compare.sh 10 0.0001 0.001 0.01` runs paired validity vs plain sends per tip.

`K1=./key1 K2=./key2 scripts/scenarios-sepolia.sh` runs five trading scenarios against a counter contract standing in for a pool: a backrun on a price move, a 7-predicate quote whose price band breaks late, a deadline that has already passed, a resting quote cancelled by a same-nonce tx, and a second leg sent without the first.

## Limits

- Predicates are checked against state at the end of the previous block. The builder checks against state mid-block, so a tx earlier in the same block can flip a result.
- A tx counts as arrived for block B only if the sequencer's reply to the submit came back more than 200ms before B's timestamp (one 200ms block). Reply time, not send time: on Sepolia, inclusion needed ack ≤ ts − 134ms and blocks with ack up to ts − 134ms didn't include it, so send time overcounts by a round trip (~150ms). Clock skew on your machine shifts this.
- On Sepolia `base_transactionStatus` is not open, so a tx the sequencer dropped looks the same as one it held: `EXPIRED_WHILE_ELIGIBLE` there can also mean dropped.
- Resubmitting the exact same signed tx after it expired is silently ignored by the sequencer (it returns the hash and never includes it). Predicates aren't signed, so the same nonce, fee and call give the same hash: `vtx send` bumps the max fee by 1 wei when a hash is already in `~/.vtx/txs`. Do the same in your own sender.
- The builder's reason for skipping an eligible tx isn't public.
