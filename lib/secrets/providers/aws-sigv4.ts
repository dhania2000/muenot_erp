import "server-only"
import crypto from "node:crypto"

/**
 * Minimal AWS Signature Version 4 signer (pure, dependency-free).
 * ---------------------------------------------------------------------------
 * The AWS Secrets Manager adapter talks to the JSON RPC endpoint directly over
 * `fetch`, which means each request must be SigV4-signed. Rather than pull in
 * the full AWS SDK we implement the exact subset needed for a signed POST:
 * canonical request → string-to-sign → signing key → Authorization header.
 * Everything here is deterministic given (credentials, time, request) so it is
 * unit-testable and never touches the network itself.
 */

export type AwsCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | null
}

export type SignInput = {
  method: string
  host: string
  region: string
  service: string
  /** Canonical URI path, defaults to "/". */
  path?: string
  headers: Record<string, string>
  body: string
  /** Overridable for deterministic tests; defaults to now. */
  now?: Date
}

const sha256Hex = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex")
const hmac = (key: string | Buffer, data: string) => crypto.createHmac("sha256", key).update(data).digest()

/** YYYYMMDD and YYYYMMDD'T'HHMMSS'Z' stamps in UTC, as SigV4 requires. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, "aws4_request")
}

/**
 * Produce the headers (including `Authorization`) for a signed request. The
 * caller merges these into the outgoing `fetch`. Host + x-amz-date are always
 * signed; a session token, when present, is included and signed too.
 */
export function signAwsRequest(input: SignInput, creds: AwsCredentials): Record<string, string> {
  const now = input.now ?? new Date()
  const { amzDate, dateStamp } = amzDates(now)
  const path = input.path ?? "/"

  const baseHeaders: Record<string, string> = {
    ...input.headers,
    host: input.host,
    "x-amz-date": amzDate,
  }
  if (creds.sessionToken) baseHeaders["x-amz-security-token"] = creds.sessionToken

  const sortedKeys = Object.keys(baseHeaders)
    .map((k) => k.toLowerCase())
    .sort()
  const canonicalHeaders = sortedKeys
    .map((k) => {
      const original = Object.keys(baseHeaders).find((h) => h.toLowerCase() === k)!
      return `${k}:${String(baseHeaders[original]).trim().replace(/\s+/g, " ")}\n`
    })
    .join("")
  const signedHeaders = sortedKeys.join(";")

  const payloadHash = sha256Hex(input.body)
  const canonicalRequest = [
    input.method.toUpperCase(),
    path,
    "", // canonical query string (none)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n")

  const key = signingKey(creds.secretAccessKey, dateStamp, input.region, input.service)
  const signature = crypto.createHmac("sha256", key).update(stringToSign).digest("hex")

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  return { ...baseHeaders, Authorization: authorization }
}
