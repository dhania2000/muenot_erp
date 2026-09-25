import "server-only"
import net from "node:net"
import type { FileScanProvider, ScanOutcome, ScanRequest, ScanVerdict } from "./file-scanning"

/**
 * Real malware-scanning backends for the storage file-security lifecycle.
 * ---------------------------------------------------------------------------
 * The scanning contract (`FileScanProvider`) and a deterministic, dependency-free
 * default (`HeuristicScanProvider`) live in `file-scanning.ts`. This module adds
 * a PRODUCTION backend — a ClamAV (clamd) adapter — and the env-driven factory
 * that selects it, all behind the exact same interface. Swapping the built-in
 * heuristic for real AV is therefore configuration, not code: set
 * `STORAGE_MALWARE_SCANNER=clamav` (+ `CLAMAV_HOST`/`CLAMAV_PORT`) and the
 * orchestrator picks this up automatically.
 *
 * The import direction is one-way: this module depends only on the TYPES from
 * `file-scanning.ts` (erased at compile time), while `file-scanning.ts` imports
 * this module's runtime factory/timeout helpers — so there is no runtime cycle.
 */

// ---------------------------------------------------------------------------
// Scan timeout (shared) — a hung/unreachable scanner must never hang an upload
// ---------------------------------------------------------------------------

/** Raised when a scan exceeds its wall-clock budget; treated as an ERROR verdict. */
export class ScanTimeoutError extends Error {
  readonly timeout = true
  constructor(message = "Scan timed out") {
    super(message)
    this.name = "ScanTimeoutError"
  }
}

/**
 * Race a scan against a deadline. On timeout the returned promise rejects with a
 * `ScanTimeoutError` (which the orchestrator converts into an ERROR verdict, so
 * a gated file's fail-closed policy withholds it). A non-positive `ms` disables
 * the guard and returns the promise unchanged.
 */
export function runWithScanTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ScanTimeoutError(`Scan exceeded ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

// ---------------------------------------------------------------------------
// ClamAV (clamd) adapter
// ---------------------------------------------------------------------------

export type ClamAvConfig = {
  host: string
  port: number
  /** Per-scan wall-clock budget in ms (connection + INSTREAM + verdict). */
  timeoutMs?: number
  /** INSTREAM chunk size in bytes (clamd default StreamMaxLength permitting). */
  chunkSize?: number
}

/** Injectable transport so the adapter is unit-testable without a live clamd. */
export type ClamdTransport = (config: ClamAvConfig, data: Buffer) => Promise<string>

const DEFAULT_CLAMAV_TIMEOUT_MS = 30_000
const DEFAULT_CHUNK_SIZE = 64 * 1024

/** The clamd INSTREAM zero-length terminator (a 4-byte big-endian 0). */
const INSTREAM_TERMINATOR = Buffer.from([0, 0, 0, 0])

/**
 * Stream `data` to clamd over TCP using the INSTREAM command and resolve with
 * clamd's raw textual verdict. Enforces `timeoutMs` end-to-end and always tears
 * the socket down. This is the only part that touches the network.
 */
function defaultClamdTransport(config: ClamAvConfig, data: Buffer): Promise<string> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_CLAMAV_TIMEOUT_MS
  const chunkSize = Math.max(1, config.chunkSize ?? DEFAULT_CHUNK_SIZE)
  return new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: config.host, port: config.port })
    const chunks: Buffer[] = []
    let settled = false

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      fn()
    }

    const timer = setTimeout(
      () => finish(() => reject(new ScanTimeoutError(`clamd did not respond within ${timeoutMs}ms`))),
      timeoutMs,
    )

    socket.setTimeout(timeoutMs, () =>
      finish(() => reject(new ScanTimeoutError(`clamd socket idle for ${timeoutMs}ms`))),
    )
    socket.on("connect", () => {
      socket.write(Buffer.from("zINSTREAM\0", "utf8"))
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        const slice = data.subarray(offset, offset + chunkSize)
        const header = Buffer.alloc(4)
        header.writeUInt32BE(slice.length, 0)
        socket.write(header)
        socket.write(slice)
      }
      socket.write(INSTREAM_TERMINATOR)
    })
    socket.on("data", (d) => chunks.push(Buffer.from(d)))
    socket.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))))
    socket.on("error", (err) => finish(() => reject(err)))
  })
}

export type ParsedClamdResponse = { verdict: ScanVerdict; signature: string | null; detail: string | null }

/**
 * Interpret a raw clamd INSTREAM reply. clamd answers with one of:
 *   - "stream: OK"                              → clean
 *   - "stream: <Signature> FOUND"               → infected
 *   - "<something> ERROR" / malformed / empty   → error (route to fail-closed)
 * Pure and total — exported so the parsing is unit-tested without a socket.
 */
export function parseClamdResponse(raw: string): ParsedClamdResponse {
  const text = (raw ?? "").replace(/\0/g, "").trim()
  if (!text) return { verdict: "error", signature: null, detail: "Empty response from clamd" }
  if (/\bFOUND$/i.test(text) || /\bFOUND\b/i.test(text)) {
    const match = text.match(/^(?:stream|instream)?:?\s*(.+?)\s+FOUND\b/i)
    const signature = match ? match[1].trim() : "unknown"
    return { verdict: "infected", signature, detail: text }
  }
  if (/\bERROR\b/i.test(text)) return { verdict: "error", signature: null, detail: text }
  if (/\bOK$/i.test(text) || /\bOK\b/i.test(text)) return { verdict: "clean", signature: null, detail: null }
  return { verdict: "error", signature: null, detail: `Unrecognized clamd response: ${text}` }
}

/**
 * Production scanning backend that hands each object to a ClamAV `clamd`
 * instance over TCP. Any transport failure (down, refused, timed out) is
 * reported as an ERROR verdict — never a throw and never a false "clean" — so
 * the download gate's fail-closed policy keeps a gated file withheld while the
 * scanner is unavailable.
 */
export class ClamAvScanProvider implements FileScanProvider {
  readonly id = "clamav"
  constructor(
    private readonly config: ClamAvConfig,
    private readonly transport: ClamdTransport = defaultClamdTransport,
  ) {}

  async scan(request: ScanRequest): Promise<ScanOutcome> {
    let buffer: Buffer
    try {
      buffer = await request.read()
    } catch {
      return { verdict: "error", provider: this.id, detail: "Could not read the stored object for scanning" }
    }
    try {
      const raw = await this.transport(this.config, buffer)
      const parsed = parseClamdResponse(raw)
      if (parsed.verdict === "infected") {
        return {
          verdict: "infected",
          provider: this.id,
          findings: [{ signature: parsed.signature ?? "unknown", severity: "critical" }],
          detail: parsed.signature,
        }
      }
      if (parsed.verdict === "clean") return { verdict: "clean", provider: this.id }
      return { verdict: "error", provider: this.id, detail: parsed.detail ?? "clamd returned an error" }
    } catch (err) {
      const timedOut = err instanceof ScanTimeoutError
      return {
        verdict: "error",
        provider: this.id,
        detail: timedOut
          ? "clamd scan timed out; file held (fail-closed)"
          : `clamd unavailable: ${(err as Error).message}`,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Env-driven factory
// ---------------------------------------------------------------------------

/**
 * Resolve a production scanning backend from configuration, or `null` to signal
 * "keep the built-in heuristic". Reading a plain env bag (defaulted to
 * `process.env`) keeps this pure and testable.
 */
export function resolveScanProviderFromEnv(env: Record<string, string | undefined> = process.env): FileScanProvider | null {
  const kind = (env.STORAGE_MALWARE_SCANNER ?? "").trim().toLowerCase()
  if (kind === "clamav" || kind === "clamd") {
    const host = (env.CLAMAV_HOST ?? "").trim()
    if (!host) return null
    const port = Number(env.CLAMAV_PORT)
    const timeoutMs = Number(env.CLAMAV_TIMEOUT_MS)
    return new ClamAvScanProvider({
      host,
      port: Number.isFinite(port) && port > 0 ? port : 3310,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CLAMAV_TIMEOUT_MS,
    })
  }
  return null
}
