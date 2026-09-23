/**
 * Phase 4: scalability benchmark harness.
 * ---------------------------------------------------------------------------
 * A dependency-free, repeatable micro-benchmark for the two scalability
 * primitives this spec added/tuned, plus an optional live database probe:
 *
 *   1. Cache throughput + hit rate  — validates the in-process TTL cache serves
 *      hot keys far faster than the backing loader, and reports the hit ratio.
 *   2. Single-flight coalescing     — proves N concurrent misses for one cold
 *      key collapse into exactly ONE loader call (no DB stampede).
 *   3. Connection-pool throughput   — OPTIONAL. Only runs when DB_* env vars are
 *      present; fires concurrent `SELECT 1`s to measure pooled round-trips.
 *
 * Run:
 *   node scripts/benchmark-scalability.mjs
 *   node --env-file-if-exists=/vercel/share/.env.project scripts/benchmark-scalability.mjs   # include DB probe
 *
 * It writes only to stdout and mutates nothing, so it is safe to run anywhere.
 */

function now() {
  return Number(process.hrtime.bigint() / 1000n) / 1000 // ms, sub-microsecond source
}

function fmt(n, digits = 2) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: digits })
}

/**
 * Minimal port of lib/cache.ts TtlCache so the benchmark stays dependency-free
 * (the real module is `server-only` and TS). Behavior mirrors the production
 * LRU + TTL + single-flight semantics being measured.
 */
class TtlCache {
  constructor({ maxEntries = 1000, defaultTtlMs = 60_000 } = {}) {
    this.store = new Map()
    this.inflight = new Map()
    this.maxEntries = maxEntries
    this.defaultTtlMs = defaultTtlMs
    this.hits = 0
    this.misses = 0
  }
  get(key) {
    const e = this.store.get(key)
    if (!e) { this.misses++; return undefined }
    if (e.expiresAt <= Date.now()) { this.store.delete(key); this.misses++; return undefined }
    this.store.delete(key); this.store.set(key, e); this.hits++
    return e.value
  }
  set(key, value, ttlMs = this.defaultTtlMs) {
    this.store.delete(key)
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs })
    while (this.store.size > this.maxEntries) this.store.delete(this.store.keys().next().value)
  }
  async getOrLoad(key, loader) {
    const cached = this.get(key)
    if (cached !== undefined) return cached
    const pending = this.inflight.get(key)
    if (pending) return pending
    const p = (async () => { try { const v = await loader(); this.set(key, v); return v } finally { this.inflight.delete(key) } })()
    this.inflight.set(key, p)
    return p
  }
}

async function benchCacheThroughput() {
  const cache = new TtlCache({ maxEntries: 10_000, defaultTtlMs: 60_000 })
  const KEYS = 500
  const OPS = 2_000_000
  // Simulate a backing loader that costs ~real work.
  let loaderCalls = 0
  const load = async (k) => { loaderCalls++; return { k, computed: k * 31 } }

  // Warm the working set.
  for (let i = 0; i < KEYS; i++) cache.set(String(i), { k: i, computed: i * 31 })

  const start = now()
  for (let i = 0; i < OPS; i++) {
    const key = String(i % KEYS)
    const v = cache.get(key)
    if (v === undefined) await cache.getOrLoad(key, () => load(i % KEYS))
  }
  const elapsed = now() - start
  const { hits, misses } = cache
  const total = hits + misses
  console.log("1) Cache throughput (hot working set)")
  console.log(`   ops:            ${fmt(OPS, 0)}`)
  console.log(`   elapsed:        ${fmt(elapsed)} ms`)
  console.log(`   throughput:     ${fmt(OPS / (elapsed / 1000), 0)} ops/sec`)
  console.log(`   hit rate:       ${fmt((hits / total) * 100)}%  (${fmt(hits, 0)} hits / ${fmt(misses, 0)} misses)`)
  console.log(`   loader calls:   ${fmt(loaderCalls, 0)}  (DB reads avoided: ${fmt(total - loaderCalls, 0)})`)
  console.log("")
}

async function benchSingleFlight() {
  const cache = new TtlCache()
  let loaderCalls = 0
  const CONCURRENCY = 1_000
  const load = async () => {
    loaderCalls++
    await new Promise((r) => setTimeout(r, 20)) // simulate a slow DB read
    return "value"
  }
  const start = now()
  await Promise.all(Array.from({ length: CONCURRENCY }, () => cache.getOrLoad("cold-key", load)))
  const elapsed = now() - start
  console.log("2) Single-flight coalescing (cold-key stampede)")
  console.log(`   concurrent callers: ${fmt(CONCURRENCY, 0)}`)
  console.log(`   loader calls:       ${fmt(loaderCalls, 0)}  ${loaderCalls === 1 ? "(coalesced to one DB read)" : "(WARNING: not coalesced)"}`)
  console.log(`   elapsed:            ${fmt(elapsed)} ms`)
  console.log("")
}

async function benchPool() {
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
    console.log("3) Connection-pool throughput")
    console.log("   skipped — DB_HOST/DB_USER/DB_NAME not set (run with --env-file to include this probe).")
    console.log("")
    return
  }
  let mysql
  try {
    mysql = (await import("mysql2/promise")).default
  } catch {
    console.log("3) Connection-pool throughput — skipped (mysql2 not resolvable in this context).")
    console.log("")
    return
  }
  const connectionLimit = Number(process.env.DB_POOL_SIZE || 10)
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit,
    enableKeepAlive: true,
  })
  const QUERIES = 2_000
  try {
    const start = now()
    await Promise.all(Array.from({ length: QUERIES }, () => pool.query("SELECT 1")))
    const elapsed = now() - start
    console.log("3) Connection-pool throughput")
    console.log(`   pool size:      ${connectionLimit}`)
    console.log(`   queries:        ${fmt(QUERIES, 0)} concurrent SELECT 1`)
    console.log(`   elapsed:        ${fmt(elapsed)} ms`)
    console.log(`   throughput:     ${fmt(QUERIES / (elapsed / 1000), 0)} queries/sec`)
    console.log(`   avg latency:    ${fmt(elapsed / QUERIES, 3)} ms/query`)
    console.log("")
  } finally {
    await pool.end()
  }
}

async function main() {
  console.log("=".repeat(72))
  console.log("Scalability benchmark")
  console.log(`node ${process.version} · ${new Date().toISOString()}`)
  console.log("=".repeat(72))
  console.log("")
  await benchCacheThroughput()
  await benchSingleFlight()
  await benchPool()
  console.log("Done.")
}

main().catch((err) => {
  console.error("Benchmark failed:", err)
  process.exit(1)
})
