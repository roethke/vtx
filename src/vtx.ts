#!/usr/bin/env node
// vtx: send and track Base validity transactions, block by block.
// Predicates live offchain, so tracking needs the predicate set: `vtx send` records it,
// or pass the original request body to `vtx track --body`.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createPublicClient, defineChain, http, parseEther, parseGwei, formatGwei, formatEther, parseTransaction,
  recoverTransactionAddress, keccak256, type Hex, type Address, type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { chainConfig } from 'viem/op-stack'

// ---------- config ----------

// OP-stack formatters tag deposit txs, so they don't count as user txs in the min-tip check.
const vibenet = defineChain({
  ...chainConfig, id: 84538453, name: 'Vibenet', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.vibes.base.org'] } },
})

type Net = 'vibenet' | 'sepolia' | 'mainnet'
const NETS = {
  vibenet: { chain: vibenet, rpc: 'https://rpc.vibes.base.org', seq: 'https://rpc.vibes.base.org', status: true },
  sepolia: { chain: baseSepolia, rpc: 'https://sepolia.base.org', seq: 'https://sepolia-sequencer.base.org', status: false },
  mainnet: { chain: base, rpc: 'https://mainnet.base.org', seq: 'https://mainnet-sequencer.base.org', status: true },
} as const
const STORE = join(homedir(), '.vtx', 'txs')
const BLOCK_MS = 200n
const DROP_MARGIN = 25n // blocks (~5s): Unknown this close to expiry is the pool's expiry eviction, not a drop
const PREFETCH = 8n
const WINDOW_BLOCKS = 300n // sequencer max validity window, 60s of 200ms blocks

type Op = '<' | '<=' | '=' | '!=' | '>' | '>='
type Predicate =
  | { type: 'balance' | 'nonce'; params: { address: Address; op: Op; value: Hex } }
  | { type: 'storage'; params: { address: Address; slot: Hex; op: Op; value: Hex; mask?: Hex } }
  | { type: 'block_number'; params: { op: Op; value: Hex } }
  // Not evaluated: flashblock positions aren't public. Base Sepolia rejects it; Vibenet accepts it but never includes the tx.
  | { type: 'flashblock_index'; params: { op: Op; value: Hex } }

type Record = {
  hash: Hex; net: Net; raw: Hex; from: Address; nonce: number
  maxFee: string; maxTip: string; predicates: Predicate[]
  sentAtMs: number | null; sentBlock: number | null; submitError?: unknown
  ackAtMs?: number // when the sequencer's reply arrived: the latest it could have received the tx
  labels?: string[] // local names for predicates, by index; never sent to the sequencer
}

// ---------- small helpers ----------

// Color only on a terminal; NO_COLOR disables, FORCE_COLOR enables (eg, when piping into `less -R`).
const COLOR = !process.env.NO_COLOR && (!!process.env.FORCE_COLOR || !!process.stdout.isTTY)
const paint = (code: number) => (s: string | number | bigint) => COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s)
const [bold, dim, red, green, yellow, cyan] = [1, 2, 31, 32, 33, 36].map(paint)

const die = (msg: string): never => { console.error(`vtx: ${msg}`); process.exit(2) }
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-4)}`
const hex = (n: bigint): Hex => `0x${n.toString(16)}`
const cmp = (a: bigint, op: Op, b: bigint) =>
  op === '<' ? a < b : op === '<=' ? a <= b : op === '=' ? a === b : op === '!=' ? a !== b : op === '>' ? a > b : a >= b
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Retries transport failures and HTTP 429/5xx with backoff; JSON-RPC errors are returned as-is.
async function rpc(url: string, method: string, params: unknown[], tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      if ((res.status === 429 || res.status >= 500) && i < tries - 1) { await sleep(200 * 2 ** i); continue }
      return (await res.json()) as { result?: any; error?: { code: number; message: string; data?: unknown } }
    } catch (e) { if (i >= tries - 1) throw e; await sleep(200 * 2 ** i) }
  }
}

const client = (net: Net) =>
  createPublicClient({ chain: NETS[net].chain, transport: http(process.env.VTX_RPC || NETS[net].rpc, { retryCount: 5, retryDelay: 200 }) }) as PublicClient

function loadKey(keyFile?: string): Hex {
  if (keyFile) {
    if (!existsSync(keyFile)) die(`no key file at ${keyFile}`)
    return readFileSync(keyFile, 'utf8').trim() as Hex
  }
  if (process.env.PK) return process.env.PK as Hex
  return die('no key: set PK or pass --key-file PATH')
}

const save = (r: Record) => { mkdirSync(STORE, { recursive: true }); writeFileSync(join(STORE, `${r.hash}.json`), JSON.stringify(r, null, 2)) }
const load = (hash: string): Record | null => {
  const f = join(STORE, `${hash.toLowerCase()}.json`)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}

// Shorthand: balance:ADDR>=VAL  nonce:ADDR=VAL  storage:ADDR:SLOT[&MASK]<=VAL  block<=VAL, with an optional ' #label'
function parseLabel(s: string): [string, string | undefined] {
  const i = s.indexOf(' #')
  return i < 0 ? [s.trim(), undefined] : [s.slice(0, i).trim(), s.slice(i + 2).trim()]
}
function parsePredicate(s: string): Predicate {
  s = parseLabel(s)[0]
  const m = s.match(/^(.*?)(<=|>=|!=|<|>|=)(0x[0-9a-fA-F]+|\d+)$/)
  if (!m) die(`bad predicate "${s}"`)
  const [, lhs, op, v] = m!
  const value: Hex = v.startsWith('0x') ? (v as Hex) : hex(BigInt(v))
  const [kind, ...rest] = lhs.split(':')
  if (kind === 'block' || kind === 'block_number') return { type: 'block_number', params: { op: op as Op, value } }
  if (kind === 'balance' || kind === 'nonce') return { type: kind, params: { address: rest[0] as Address, op: op as Op, value } }
  if (kind === 'storage') {
    const [slot, mask] = rest[1].split('&')
    return { type: 'storage', params: { address: rest[0] as Address, slot: slot as Hex, op: op as Op, value, ...(mask ? { mask: mask as Hex } : {}) } }
  }
  return die(`unknown predicate type "${kind}"`)
}

// Storage words read as numbers when unmasked and small (prices, counters); masked or large words stay hex.
const fmtWord = (v: bigint, masked: boolean) => masked || v >= 10n ** 15n ? hex(v) : `${v}`

const describe = (p: Predicate) =>
  p.type === 'block_number' ? `block ${p.params.op} ${BigInt(p.params.value)}`
  : p.type === 'flashblock_index' ? `flashblock_index ${p.params.op} ${BigInt(p.params.value)} (not evaluated)`
  : p.type === 'storage' ? `storage[${short(p.params.address)}][${p.params.slot}]${p.params.mask ? ` & ${p.params.mask}` : ''} ${p.params.op} ${fmtWord(BigInt(p.params.value), !!p.params.mask)}`
  : p.type === 'balance' || p.type === 'nonce' ? `${p.type}(${short(p.params.address)}) ${p.params.op} ${p.type === 'balance' ? `${formatEther(BigInt(p.params.value))} ETH` : BigInt(p.params.value)}`
  : `${(p as any).type} ${JSON.stringify((p as any).params)} (not evaluated)`

// The highest block the tx may land in, from its block_number predicates.
function expiryBlock(ps: Predicate[]): bigint | null {
  let max: bigint | null = null
  for (const p of ps) {
    if (p.type !== 'block_number') continue
    const v = BigInt(p.params.value)
    const b = p.params.op === '<' ? v - 1n : p.params.op === '<=' || p.params.op === '=' ? v : null
    if (b !== null && (max === null || b < max)) max = b
  }
  return max
}

const fmtActual = (e: { actual: bigint; p: Predicate; unknown?: boolean }) => e.unknown ? 'not evaluated' : e.p.type === 'balance' ? `${formatEther(e.actual)} ETH` : e.p.type === 'storage' ? fmtWord(e.actual, !!e.p.params.mask) : `${e.actual}`
const fmtVal = (p: Predicate) => p.type === 'balance' ? `${formatEther(BigInt(p.params.value))} ETH` : p.type === 'storage' ? fmtWord(BigInt(p.params.value), !!p.params.mask) : `${BigInt(p.params.value)}`

// ---------- predicate evaluation ----------

// unknown: vtx can't read this predicate (eg, flashblock_index). It counts as holding so the rest can still be judged.
type Eval = { ok: boolean; actual: bigint; p: Predicate; unknown?: boolean }

// Evaluates predicates as the builder would for block `target`, using state at the end of target-1.
// Builders check against state mid-block, so a tx earlier in `target` can flip a result: this is an approximation.
async function evaluate(c: PublicClient, ps: Predicate[], target: bigint): Promise<Eval[]> {
  const at = target - 1n
  return Promise.all(ps.map(async (p): Promise<Eval> => {
    let actual: bigint
    if (p.type === 'block_number') actual = target
    else if (p.type === 'balance') actual = await c.getBalance({ address: p.params.address, blockNumber: at })
    else if (p.type === 'nonce') actual = BigInt(await c.getTransactionCount({ address: p.params.address, blockNumber: at }))
    else if (p.type === 'storage') {
      const word = BigInt((await c.getStorageAt({ address: p.params.address, slot: p.params.slot, blockNumber: at })) ?? '0x0')
      actual = p.params.mask ? word & BigInt(p.params.mask) : word
    } else return { ok: true, actual: 0n, p, unknown: true }
    return { ok: cmp(actual, p.params.op, BigInt(p.params.value)), actual, p }
  }))
}

// Validity txs the sequencer still holds for this sender. They don't count in the 'pending' nonce,
// so a new send would reuse the nonce and fail as an underpriced replacement.
async function heldNonces(net: Net, from: Address, pendingNonce: number, head: bigint): Promise<Map<number, { hash: Hex; expiry: bigint }>> {
  const held = new Map<number, { hash: Hex; expiry: bigint }>()
  if (!existsSync(STORE)) return held
  for (const f of readdirSync(STORE)) {
    if (!f.endsWith('.json')) continue
    let r: Record
    try { r = JSON.parse(readFileSync(join(STORE, f), 'utf8')) } catch { continue }
    if (r.net !== net || r.from.toLowerCase() !== from.toLowerCase() || r.submitError || !r.predicates?.length || r.nonce < pendingNonce) continue
    const exp = expiryBlock(r.predicates)
    if (exp === null || exp < head) continue
    held.set(r.nonce, { hash: r.hash, expiry: exp })
  }
  // Where the status endpoint is open, keep only txs the sequencer still knows; elsewhere a dropped tx can't be told apart.
  if (NETS[net].status) for (const [n, h] of held) {
    const s = await rpc(NETS[net].seq, 'base_transactionStatus', [h.hash]).then(r => r.result?.status).catch(() => null)
    if (s === 'Unknown') held.delete(n)
  }
  return held
}

// ---------- send ----------

async function send(o: { net: Net; to?: string; value?: string; data?: string; gas?: string; tip?: string; nonce?: string
  predicates: string[]; validity?: string; expire: number; keyFile?: string; noTrack: boolean; json: boolean; plain: boolean; timeoutS?: number }) {
  const cfg = NETS[o.net]
  const c = client(o.net)
  const acct = privateKeyToAccount(loadKey(o.keyFile))
  const to = (o.to ?? acct.address) as Address
  const data = (o.data ?? '0x') as Hex
  let [gas, nonce] = await Promise.all([
    o.gas ? BigInt(o.gas) : c.estimateGas({ account: acct.address, to, data, value: parseEther(o.value ?? '0') }),
    o.nonce !== undefined ? Number(o.nonce) : c.getTransactionCount({ address: acct.address, blockTag: 'pending' }),
  ])
  // An earlier validity tx of ours may still hold the pending nonce; sending now would fail as an underpriced replacement,
  // and skipping past it would leave a nonce gap if it never lands. It expires within 60s, so wait it out, then re-read.
  for (let held; o.nonce === undefined && (held = (await heldNonces(o.net, acct.address, nonce, await c.getBlockNumber())).get(nonce));) {
    if (!o.json) console.log(dim(`  nonce ${nonce} is held by ${short(held.hash)} until block ${held.expiry}; waiting for it to land or expire. Pass --nonce to replace or queue behind it instead`))
    while (await c.getBlockNumber() <= held.expiry) await sleep(1000)
    nonce = await c.getTransactionCount({ address: acct.address, blockTag: 'pending' })
  }
  // Read the head last: --expire and blocks-to-inclusion are relative to it, and each RPC above costs ~1 block.
  const head = await c.getBlock({ blockTag: 'latest' })

  const preds: Predicate[] = o.validity ? JSON.parse(o.validity.startsWith('[') ? o.validity : readFileSync(o.validity, 'utf8')) : []
  const labels: string[] = preds.map(() => '')
  for (const e of o.predicates) { preds.push(parsePredicate(e)); labels.push(parseLabel(e)[1] ?? '') }
  // Only an upper bound expires the tx: a lone block>=N still needs one.
  if (!o.plain && expiryBlock(preds) === null) {
    preds.push({ type: 'block_number', params: { op: '<=', value: hex(head.number + BigInt(o.expire)) } })
    labels.push('expiry')
  }

  const tip = parseGwei(o.tip ?? '0.001')
  const maxFee0 = (head.baseFeePerGas ?? 0n) * 2n + tip
  // Predicates aren't part of the signed tx, so the same nonce/fee/call signs to the same hash as an earlier attempt.
  // The sequencer keeps an expired hash for a while and silently ignores a resubmit (returns the hash, never includes it),
  // so bump maxFee by 1 wei until the hash is new to the local store.
  let raw: Hex, maxFee = maxFee0
  for (;;) {
    raw = await acct.signTransaction({
      chainId: cfg.chain.id, type: 'eip1559', to, data, value: parseEther(o.value ?? '0'),
      gas, nonce, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip,
    })
    if (!load(keccak256(raw))) break
    maxFee++
  }

  const body = o.plain ? ['eth_sendRawTransaction', [raw]] as const : ['base_sendRawTransactionValidity', [raw, { validity: preds }]] as const
  const sentAtMs = Date.now()
  const res = await rpc(cfg.seq, body[0], body[1] as unknown as unknown[], 1)
  const ackAtMs = Date.now()
  const hash = keccak256(raw)
  const rec: Record = {
    hash, net: o.net, raw, from: acct.address, nonce, maxFee: maxFee.toString(), maxTip: tip.toString(),
    predicates: o.plain ? [] : preds, labels: o.plain ? [] : labels, sentAtMs, ackAtMs, sentBlock: Number(head.number), ...(res.error ? { submitError: res.error } : {}),
  }
  save(rec)

  if (res.error) return track(rec, { json: o.json, quiet: false })
  if (!o.json) {
    console.log(`${bold('sent')} ${cyan(hash)}`)
    console.log(dim(`  from ${acct.address} nonce ${nonce}, tip ${formatGwei(tip)} gwei, head block ${head.number}`))
    if (rec.predicates.length) console.log(`  predicates ${dim('(all must hold in the same block)')}:`)
    const w = Math.max(0, ...labels.map(l => l.length)), iw = String(rec.predicates.length).length
    rec.predicates.forEach((p, i) => console.log(`    ${bold(String(i + 1).padStart(iw))}  ${w ? labels[i].padEnd(w) + '  ' : ''}${describe(p)}`))
    if (rec.predicates.some(p => p.type === 'flashblock_index'))
      console.log(yellow(`  flashblock_index can't be read from public data, so vtx treats it as holding. Base Sepolia rejects it; Vibenet accepts it but has not included such a tx`))
  }
  if (!o.noTrack) return track(rec, { json: o.json, quiet: false, timeoutS: o.timeoutS })
  if (o.json) console.log(JSON.stringify({ hash }))
  return null
}

// ---------- track ----------

type Verdict =
  | 'INCLUDED' | 'INCLUDED_REVERTED' | 'EXPIRED_PREDICATE_FALSE' | 'EXPIRED_WHILE_ELIGIBLE'
  | 'EXPIRED_BEFORE_ARRIVAL' | 'EXPIRED_NONCE_GAP' | 'REPLACED' | 'DROPPED' | 'REJECTED' | 'TIMEOUT'

async function track(rec: Record, o: { json: boolean; quiet: boolean; timeoutS?: number }) {
  const cfg = NETS[rec.net]
  const c = client(rec.net)
  const log = (s: string) => { if (!o.json && !o.quiet) console.log(s) }
  const tx = parseTransaction(rec.raw) as { maxPriorityFeePerGas?: bigint; maxFeePerGas?: bigint; nonce?: number }
  const expiry = expiryBlock(rec.predicates)
  const timeoutMs = (o.timeoutS ?? 90) * 1000, deadline = Date.now() + timeoutMs
  // A receipt lookup can miss on a lagging RPC node: re-check before any negative verdict.
  const receiptOf = async (tries = 1) => {
    for (let i = 0; i < tries; i++) {
      const r = await c.getTransactionReceipt({ hash: rec.hash }).catch(() => null)
      if (r || i === tries - 1) return r
      await sleep(250)
    }
    return null
  }

  let head = await c.getBlockNumber()
  let next: bigint
  if (rec.sentBlock !== null) next = BigInt(rec.sentBlock) + 1n
  else {
    // No send record: replay from the inclusion block if it landed; if it already expired, the whole validity window
    // (at most 60s = 300 blocks before expiry); else go live from the next block.
    const r = await receiptOf()
    next = r ? r.blockNumber : expiry !== null && head >= expiry ? expiry - WINDOW_BLOCKS + 1n : head + 1n
    log(`  no send record: replay starts at block ${next}. Arrival time unknown, so blocks before submission count as eligible; pass --from with the head block at send time`)
  }
  const arrivalMs = rec.ackAtMs ?? rec.sentAtMs
  const rows: any[] = []
  let eligibleBlocks = 0, firstEligible: bigint | null = null, lastFail: Eval[] = [], everKnown = false
  let tipBelowMinBlocks = 0, includedBlock: bigint | null = null, verdict: Verdict | null = null, receiptStatus: string | null = null
  let replacedBy: Hex | null = null, flippedInBlock = false, feeBelowBaseBlocks = 0, nonceGapBlocks = 0
  // Eligible at the start of block B but false at the start of B+1: a tx in B changed watched state, and if it ran
  // before ours the predicates were false when the builder reached us. Detected one block late, so remember B.
  let lastEligible: { block: bigint; reason: 'gap' | 'fee' | 'tip' | null; evals: Eval[] } | null = null
  let flippedFalseBlocks = 0, flippedFalseLast: { block: bigint; preds: number[] } | null = null
  const label = (i: number) => rec.labels?.[i] || ''
  const name = (i: number) => `#${i + 1}${label(i) ? ` ${label(i)}` : ''}`
  // Per predicate, over blocks the tx had arrived for: how often it held, when it first failed, its latest value.
  const chain = rec.predicates.map(() => ({ held: 0, checked: 0, firstFail: null as bigint | null, last: null as Eval | null, lastBad: null as Eval | null }))
  // Identical consecutive rows collapse into one '⋮' line, so long windows stay readable.
  let lastKey = '', repeat = 0, repeatTo = 0n
  const flush = () => { if (repeat) log(dim(`  ⋮ same for ${repeat} more block${repeat > 1 ? 's' : ''} (through ${repeatTo})`)); repeat = 0 }

  // Inclusion and replacement are read from the block body; the receipt is fetched only to confirm and get status.
  // Sender nonce at the end of b-1: below the tx nonce means an earlier nonce is missing (gap), so the tx can't run.
  const probe = (b: bigint) => Promise.all([
    c.getBlock({ blockNumber: b, includeTransactions: true }),
    evaluate(c, rec.predicates, b),
    c.getTransactionCount({ address: rec.from, blockNumber: b - 1n }),
  ] as const)
  const pending = new Map<bigint, ReturnType<typeof probe>>()

  if (rec.submitError) verdict = 'REJECTED'
  if (expiry !== null && !verdict) log(`  expires after block ${expiry}`)

  while (!verdict) {
    if (Date.now() > deadline) { verdict = 'TIMEOUT'; break }
    if (head < next) {
      await sleep(60)
      head = await c.getBlockNumber().catch(() => head)
      continue
    }

    const target = next
    // Fetch up to PREFETCH blocks concurrently when behind: one block at a time can't keep up with 200ms blocks.
    for (let b = target; b <= head && b < target + PREFETCH; b++) if (!pending.has(b)) pending.set(b, probe(b))
    const [block, evals, nonceBefore] = await pending.get(target)!
    pending.delete(target)
    const live = head - target < 3n
    const status: string | null = cfg.status && live ? await rpc(cfg.seq, 'base_transactionStatus', [rec.hash]).then(r => r.result?.status ?? null).catch(() => null) : null
    if (status === 'Known') everKnown = true
    const txs = block.transactions as any[]
    const ours = txs.some(t => t.hash === rec.hash)
    const other = txs.find(t => t.hash !== rec.hash && t.from?.toLowerCase() === rec.from.toLowerCase() && t.nonce === tx.nonce)
    const nonceUsed = !!other
    const receipt = ours || (expiry !== null && target >= expiry) ? await receiptOf(ours ? 8 : 2) : null

    // Arrival: a tx is only considered for block B if the sequencer had it before B started building (~ts - 200ms).
    // The sequencer's reply time bounds when it had the tx; the send time alone overcounts by one round trip.
    const tsMs = BigInt((block as any).timestampMs ?? block.timestamp * 1000n)
    const arrived = arrivalMs == null || BigInt(arrivalMs) < tsMs - BLOCK_MS

    // Lowest effective tip among user txs that landed in this block, to compare with ours.
    const baseFee = block.baseFeePerGas ?? 0n
    const effTip = (t: { maxPriorityFeePerGas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint }) =>
      t.maxPriorityFeePerGas !== undefined && t.maxFeePerGas !== undefined
        ? (t.maxFeePerGas - baseFee < t.maxPriorityFeePerGas ? t.maxFeePerGas - baseFee : t.maxPriorityFeePerGas)
        : (t.gasPrice ?? baseFee) - baseFee
    const ourTip = effTip(tx)
    let minTip: bigint | null = null
    for (const t of block.transactions as any[]) {
      if (t.type === 'deposit' || t.hash === rec.hash) continue
      const eff = effTip(t)
      if (minTip === null || eff < minTip) minTip = eff
    }

    const allOk = evals.every(e => e.ok)
    const inThis = !!receipt && receipt.blockNumber === target
    const eligible = allOk && arrived
    const underBase = tx.maxFeePerGas !== undefined && tx.maxFeePerGas < baseFee
    // A gap only blocks the tx if the missing nonces aren't filled earlier in this same block.
    const gap = tx.nonce !== undefined && nonceBefore < tx.nonce &&
      !txs.some(t => t.from?.toLowerCase() === rec.from.toLowerCase() && t.nonce === tx.nonce! - 1)
    if (lastEligible && lastEligible.block === target - 1n && !inThis) {
      // block_number links change every block by design, so only state links count as a flip.
      const flipped = evals.flatMap((e, i) => !e.ok && lastEligible!.evals[i].ok && e.p.type !== 'block_number' ? [i] : [])
      if (flipped.length && (lastEligible.reason === null || lastEligible.reason === 'tip')) {
        if (lastEligible.reason === 'tip') tipBelowMinBlocks--
        flippedFalseBlocks++
        flippedFalseLast = { block: lastEligible.block, preds: flipped }
      }
    }
    lastEligible = null
    if (!inThis && eligible) {
      eligibleBlocks++; firstEligible ??= target
      let reason: 'gap' | 'fee' | 'tip' | null = null
      if (gap) { nonceGapBlocks++; reason = 'gap' }
      else if (underBase) { feeBelowBaseBlocks++; reason = 'fee' }
      else if (minTip !== null && ourTip < minTip) { tipBelowMinBlocks++; reason = 'tip' }
      lastEligible = { block: target, reason, evals }
    }
    if (!allOk && !inThis) lastFail = evals.filter(e => !e.ok)
    if (arrived && !inThis) evals.forEach((e, i) => {
      const s = chain[i]; s.checked++; s.last = e
      if (e.ok) s.held++; else { s.firstFail ??= target; s.lastBad = e }
    })
    // Predicates read false at the end of the previous block but the tx landed: a tx earlier in this block flipped them.
    if (inThis && !allOk) flippedInBlock = true

    // One mark per predicate (1✓ 2✗ …), then what each failing predicate read vs what it wants.
    const marks = evals.map((e, i) => e.unknown ? yellow(`${i + 1}?`) : e.ok ? green(`${i + 1}✓`) : red(`${i + 1}✗`)).join(' ')
    const fails = evals.map((e, i) => e.ok ? null : `${red(name(i))}: ${fmtActual(e)}, want ${e.p.params.op} ${fmtVal(e.p)}`).filter(Boolean)
    const extras = [
      arrived ? null : 'not yet arrived',
      gap ? yellow(`nonce gap: sender at ${nonceBefore}, tx nonce ${tx.nonce}`) : null,
      underBase ? yellow(`max fee ${formatGwei(tx.maxFeePerGas!)} < base fee ${formatGwei(baseFee)}`) : null,
      status ? `seq: ${status}` : null,
      minTip !== null ? `min tip ${formatGwei(minTip)}` : 'no user txs',
    ].filter(Boolean)
    rows.push({ block: Number(target), predicates: evals.map(e => ({ type: e.p.type, ok: e.ok, actual: hex(e.actual) })), arrived, seq: status, minTip: minTip?.toString() ?? null, included: inThis })
    const row = inThis
      ? `${dim('block')} ${target}  ${green(bold('INCLUDED'))}${flippedInBlock ? dim(` (at block start: ${marks}; a tx earlier in this block made them true)`) : ''}`
      : `${dim('block')} ${target}  ${marks}${allOk && arrived ? green('  all hold') : ''}${fails.length ? '  ' + fails.join(dim(' · ')) : ''}  ${dim('[')}${extras.map(x => dim(x!)).join(dim(', '))}${dim(']')}`
    // Rows repeat when nothing changed: key on pass/fail pattern, flags, and failing state values.
    // block_number values change every block, so they're left out or a block>=N chain never collapses.
    const key = [evals.map(e => e.ok).join(), arrived, gap, underBase,
      evals.map((e, i) => e.ok || e.p.type === 'block_number' ? '' : `${i}:${e.actual}`).join()].join('|')

    if (receipt && receipt.blockNumber > target) {
      // receipt is ahead of the block being replayed: keep walking so every block gets a line
    } else if (receipt) {
      includedBlock = receipt.blockNumber
      receiptStatus = receipt.status
      verdict = receipt.status === 'success' ? 'INCLUDED' : 'INCLUDED_REVERTED'
    } else if (nonceUsed) {
      verdict = 'REPLACED'
      replacedBy = other.hash
    } else if (expiry !== null && target >= expiry && tx.nonce !== undefined && await c.getTransactionCount({ address: rec.from, blockNumber: target }) > tx.nonce) {
      verdict = 'REPLACED' // nonce used in a block before the replay window
    } else if (expiry !== null && target >= expiry) {
      verdict = eligibleBlocks > 0 ? (nonceGapBlocks === eligibleBlocks ? 'EXPIRED_NONCE_GAP' : 'EXPIRED_WHILE_ELIGIBLE') : rows.some(r => r.arrived) ? 'EXPIRED_PREDICATE_FALSE' : 'EXPIRED_BEFORE_ARRIVAL'
    } else if (cfg.status && everKnown && status === 'Unknown' && (expiry === null || expiry - target > DROP_MARGIN) &&
      (tx.nonce === undefined || await c.getTransactionCount({ address: rec.from, blockTag: 'latest' }) <= tx.nonce)) {
      // The pool also evicts at expiry and on replacement; those keep replaying to their own verdict.
      verdict = 'DROPPED'
    }
    if (key === lastKey && !inThis && !verdict) { repeat++; repeatTo = target }
    else { flush(); log(row); lastKey = key }
    next++
  }

  flush()
  const sent = rec.sentBlock !== null ? BigInt(rec.sentBlock) : null
  const summary = {
    hash: rec.hash, net: rec.net, verdict,
    sentBlock: rec.sentBlock, expiryBlock: expiry !== null ? Number(expiry) : null,
    includedBlock: includedBlock !== null ? Number(includedBlock) : null,
    blocksToInclusion: includedBlock !== null && sent !== null ? Number(includedBlock - sent) : null,
    receiptStatus, replacedBy, flippedInBlock,
    eligibleBlocksNotIncluded: eligibleBlocks,
    firstEligibleBlock: firstEligible !== null ? Number(firstEligible) : null,
    eligibleBlocksWithNonceGap: nonceGapBlocks,
    eligibleBlocksWithMaxFeeBelowBaseFee: feeBelowBaseBlocks,
    eligibleBlocksWithTipBelowBlockMin: tipBelowMinBlocks,
    eligibleBlocksFlippedFalseInBlock: flippedFalseBlocks,
    lastFailingPredicates: lastFail.map(e => ({ predicate: e.p, actual: hex(e.actual) })),
    tip: rec.maxTip, submitError: rec.submitError ?? null,
    arrivalKnown: arrivalMs != null,
    statusEndpoint: cfg.status ? 'base_transactionStatus' : 'unavailable on this network',
    chain: chain.map((s, i) => ({ index: i + 1, label: label(i) || null, predicate: rec.predicates[i], heldBlocks: s.held, checkedBlocks: s.checked,
      firstFailBlock: s.firstFail !== null ? Number(s.firstFail) : null, lastActual: s.last ? hex(s.last.actual) : null })),
    blocks: rows,
  }
  process.exitCode = verdict === 'INCLUDED' ? 0 : 1
  if (o.json) { console.log(JSON.stringify(summary)); return summary }

  log('')
  const noStatus = cfg.status ? '' : '. Drop status is not public on this network, so the sequencer may also have dropped it'
  const explain = (): string => {
    switch (verdict!) {
      case 'INCLUDED': return `included in block ${includedBlock}${sent !== null ? ` (+${includedBlock! - sent} blocks after head ${sent})` : ''}` +
        (flippedInBlock ? `. Predicates were false at the start of block ${includedBlock} and a tx earlier in that block made them true` : '')
      case 'INCLUDED_REVERTED': return `included in block ${includedBlock} but REVERTED onchain: predicates passed, execution failed`
      case 'EXPIRED_PREDICATE_FALSE': {
        // Every link that failed during the window, most-failed first: in a band, the last failure alone hides the other side.
        // Links still false at expiry come first (they broke last), then the rest by blocks failed.
        const atEnd = new Set(lastFail.map(e => rec.predicates.indexOf(e.p)))
        const failed = chain.map((s, i) => ({ s, i })).filter(({ s }) => s.checked > s.held)
          .sort((a, b) => Number(atEnd.has(b.i)) - Number(atEnd.has(a.i)) || (b.s.checked - b.s.held) - (a.s.checked - a.s.held))
        const why = failed.map(({ s, i }) => `${name(i)}${label(i) ? '' : ` ${describe(rec.predicates[i])}`} failed ${s.checked - s.held}/${s.checked} blocks (${atEnd.has(i) ? 'last value' : 'last failing value'} ${s.lastBad ? fmtActual(s.lastBad) : '-'})`)
        if (!why.length) why.push(...lastFail.map(e => { const i = rec.predicates.indexOf(e.p); return `${name(i)}${label(i) ? '' : ` ${describe(e.p)}`} (last value ${fmtActual(e)})` }))
        return `expired after block ${expiry}. After the tx reached the sequencer, its predicates were never all true in the same block. ` +
          (why.length ? `${why.length > 1 ? 'The ones' : 'The one'} that kept it out: ${why.join('; ')}` : '')
      }
      case 'EXPIRED_WHILE_ELIGIBLE': {
        if (rec.predicates.some(p => p.type === 'flashblock_index'))
          return `expired after block ${expiry}: every predicate vtx can read held for ${eligibleBlocks} block(s) from ${firstEligible}, but the tx has a flashblock_index predicate, which vtx can't check. Vibenet accepts it at submit but has not included such a tx, so that is the likely reason`
        const other = eligibleBlocks - nonceGapBlocks - feeBelowBaseBlocks - flippedFalseBlocks - tipBelowMinBlocks
        return `expired after block ${expiry} while eligible: all predicates held for ${eligibleBlocks} block(s) from ${firstEligible} and the tx was not included` +
        (nonceGapBlocks ? `. In ${nonceGapBlocks} of them the sender's previous nonce had not landed (nonce gap), so the tx could not execute` : '') +
        (feeBelowBaseBlocks ? `. Your max fee was below the base fee in ${feeBelowBaseBlocks} of them, so the tx could not pay for inclusion` : '') +
        (flippedFalseBlocks ? `. In ${flippedFalseBlocks} of them a tx in that same block made ${flippedFalseLast!.preds.map(name).join(', ')} false (last: block ${flippedFalseLast!.block}); ordered ahead of yours, eg, by a higher tip, it ran first and the predicates no longer held when the builder reached your tx` : '') +
        (tipBelowMinBlocks ? `. Your tip was below the lowest included tip in ${tipBelowMinBlocks} of them` : '') +
        (other > 0
          ? `. ${other < eligibleBlocks ? `In the other ${other}, your` : 'Your'} tip was at or above the lowest included tip, so the public data does not explain the miss` +
            (arrivalMs == null ? ' (arrival time unknown, so blocks before you submitted count as eligible)' : '') + noStatus
          : '')
      }
      case 'EXPIRED_NONCE_GAP': return `expired after block ${expiry}: predicates held for ${eligibleBlocks} block(s) from ${firstEligible}, but the sender's nonce never reached ${tx.nonce} (an earlier nonce was missing), so the tx could not execute`
      case 'EXPIRED_BEFORE_ARRIVAL': return `expired after block ${expiry} before the sequencer could consider it: every block up to expiry started building before the tx arrived. Use a later block_number bound`
      case 'REPLACED': return `sender nonce ${rec.nonce} was used by ${replacedBy ?? 'another transaction'}`
      case 'DROPPED': return `dropped: sequencer reported Unknown before expiry, with no receipt or replacement`
      case 'REJECTED': {
        // -32602 puts the useful part (eg, "unknown variant `=>`") in data, not message.
        const e = rec.submitError as any, data = e?.data === undefined ? '' : `: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`
        const held = /underpriced|already known/i.test(e?.message ?? '') ? '. An earlier validity tx from this sender may still hold the nonce; vtx skips held nonces it sent itself' : ''
        return `rejected at submit: ${e?.message ?? JSON.stringify(e)}${data}${e?.code !== undefined ? ` (code ${e.code})` : ''}${held}`
      }
      case 'TIMEOUT': return `still pending after ${timeoutMs / 1000}s of tracking (last block checked ${next - 1n})` + (expiry === null ? ' and the tx has no block_number expiry' : '')
    }
  }
  const tone = verdict === 'INCLUDED' ? green : verdict === 'REPLACED' || verdict === 'TIMEOUT' ? yellow : red
  console.log(`${tone(bold(verdict!))}: ${explain()}`)
  if (verdict !== 'INCLUDED' && verdict !== 'INCLUDED_REVERTED' && eligibleBlocks && verdict !== 'EXPIRED_WHILE_ELIGIBLE')
    console.log(`  note: eligible but not included for ${eligibleBlocks} block(s)`)

  // Predicate chain: which link held, which broke, and when. Skipped when nothing was checked (eg, included on arrival).
  const checked = Math.max(0, ...chain.map(s => s.checked))
  if (verdict !== 'INCLUDED' && verdict !== 'REJECTED' && checked) {
    const w = Math.max(4, ...rec.predicates.map((_, i) => label(i).length)), iw = String(chain.length).length
    log('')
    log(bold(`predicate chain`) + dim(` (${checked} block${checked > 1 ? 's' : ''} after arrival; all held together in ${eligibleBlocks})`))
    log(dim(`  ${'#'.padStart(iw)}  ${'name'.padEnd(w)}  ${'held'.padEnd(9)}  ${'first ✗'.padEnd(10)}  last value vs target`))
    chain.forEach((s, i) => {
      const unknown = !!s.last?.unknown
      const held = (unknown ? 'n/a' : `${s.held}/${s.checked}`).padEnd(9)
      const tint = unknown ? yellow : s.held === s.checked ? green : s.held === 0 ? red : yellow
      const last = s.last ? `${fmtActual(s.last)} vs ${s.last.p.params.op} ${fmtVal(s.last.p)}` : '-'
      log(`  ${String(i + 1).padStart(iw)}  ${label(i).padEnd(w)}  ${tint(held)}  ${(s.firstFail !== null ? String(s.firstFail) : '-').padEnd(10)}  ${s.last && !s.last.ok ? red(last) : last}`)
    })
    if (chain.some(s => s.last?.unknown)) log(yellow(`  n/a: vtx can't read flashblock_index, so it can't rule it out as the reason for a miss`))
  }
  return summary
}

// ---------- cli ----------

const HELP = `vtx: send and track Base validity transactions

  vtx send [options]            sign, submit and track a validity tx
    --net vibenet|sepolia|mainnet  default vibenet
    --to ADDR --value ETH --data HEX --gas N --tip GWEI (default 0.001)
                                no --to: a 0-value transfer to yourself
    -p, --predicate EXPR        repeatable. balance:ADDR>=VAL  nonce:ADDR=VAL (VAL in wei)
                                storage:ADDR:SLOT[&MASK]<=VAL  block<=N
                                append ' #name' to label it in the output (local only)
    --validity JSON|FILE        predicate array in RPC format
    --expire N                  auto block_number <= head+N if none given (default 50)
    --nonce N                   override the sender nonce (default: pending count)
    --timeout S                 stop tracking after S seconds (default 90)
    --plain                     send as eth_sendRawTransaction (control group)
    --no-track, --json, --key-file PATH (or PK env)

  vtx track HASH [options]      track a tx sent with vtx send
    --body FILE                 original base_sendRawTransactionValidity body or params
    --from N                    first block to replay (default: inclusion block, or the
                                60s window before expiry, or the next block if still live)
    --net, --json, --timeout S (default 90)
    Exit code: 0 for INCLUDED, 1 for any other verdict, 2 for usage errors.

  vtx show HASH                 print the stored record
`

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      net: { type: 'string', default: 'vibenet' }, to: { type: 'string' }, value: { type: 'string' },
      data: { type: 'string' }, gas: { type: 'string' }, tip: { type: 'string' }, nonce: { type: 'string' },
      predicate: { type: 'string', short: 'p', multiple: true, default: [] }, validity: { type: 'string' },
      expire: { type: 'string', default: '50' }, plain: { type: 'boolean', default: false },
      'no-track': { type: 'boolean', default: false }, json: { type: 'boolean', default: false },
      'key-file': { type: 'string' }, body: { type: 'string' }, from: { type: 'string' }, timeout: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [cmd, arg] = positionals
  const net = v.net as Net
  if (!(net in NETS)) die(`unknown net ${net}`)
  if (!cmd || v.help) { console.log(HELP); return }

  if (cmd === 'send') {
    await send({ net, to: v.to, value: v.value, data: v.data, gas: v.gas, tip: v.tip, nonce: v.nonce, predicates: v.predicate as string[],
      validity: v.validity, expire: Number(v.expire), keyFile: v['key-file'], noTrack: v['no-track']!, json: v.json!, plain: v.plain!,
      timeoutS: v.timeout ? Number(v.timeout) : undefined })
  } else if (cmd === 'track') {
    if (!arg) die('track needs a tx hash')
    let rec = load(arg)
    if (v.body) {
      const b = JSON.parse(readFileSync(v.body, 'utf8'))
      const params = Array.isArray(b) ? b : b.params
      const raw = params?.[0] as Hex
      if (typeof raw !== 'string' || !raw.startsWith('0x')) die('--body: expected a JSON-RPC body or params array with the raw tx first')
      if (keccak256(raw).toLowerCase() !== arg.toLowerCase()) die(`--body: raw tx hashes to ${keccak256(raw)}, not ${arg}`)
      const t = parseTransaction(raw) as any
      if (t.chainId !== undefined && t.chainId !== NETS[net].chain.id) die(`--body: tx is for chain ${t.chainId}, not ${net} (${NETS[net].chain.id}); pass --net`)
      rec = { hash: keccak256(raw), net, raw, from: await recoverTransactionAddress({ serializedTransaction: raw as any }), nonce: t.nonce,
        maxFee: String(t.maxFeePerGas ?? 0), maxTip: String(t.maxPriorityFeePerGas ?? 0), predicates: params[1]?.validity ?? [],
        sentAtMs: null, sentBlock: v.from !== undefined ? Number(v.from) - 1 : null }
    }
    if (!rec) die(`no record for ${arg}: predicates are offchain, so pass --body with the original base_sendRawTransactionValidity request`)
    await track(rec!, { json: v.json!, quiet: false, timeoutS: v.timeout ? Number(v.timeout) : undefined })
  } else if (cmd === 'show') {
    const rec = load(arg ?? '') ?? die('no record')
    console.log(JSON.stringify(rec, null, 2))
  } else die(`unknown command ${cmd}\n${HELP}`)
}

process.stdout.on('error', e => { if ((e as any).code === 'EPIPE') process.exit(0); throw e })
main().catch(e => die(e?.shortMessage ?? e?.message ?? String(e)))
