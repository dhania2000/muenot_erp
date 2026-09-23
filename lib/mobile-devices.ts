import "server-only"
import { createHash } from "node:crypto"
import { query, withTransaction } from "@/lib/db"
import { encryptToken } from "@/lib/token-crypto"

const hash = (token: string) => createHash("sha256").update(token).digest("hex")
const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) || null : null

/** Store one encrypted push token per authenticated user installation. */
export async function registerMobileDevice(input: {
  tenantId: number; userId: number; sessionId: string; deviceId: string; token: string
  deviceName?: string; platform?: string; appVersion?: string; provider?: string
}) {
  const token = input.token.trim()
  const deviceId = input.deviceId.trim()
  if (token.length < 20 || token.length > 4096) throw new Error("Invalid device token")
  if (!deviceId || deviceId.length > 160) throw new Error("Invalid device identifier")
  const platform = clean(input.platform, 32)?.toLowerCase() ?? null
  if (platform && !["android", "ios"].includes(platform)) throw new Error("Unsupported device platform")
  const provider = input.provider?.trim().toLowerCase() || "fcm"
  if (provider !== "fcm") throw new Error("Unsupported push provider")
  const encrypted = encryptToken(token)
  if (!encrypted?.startsWith("enc:v1:")) throw new Error("Secure device registration is unavailable")
  const tokenHash = hash(token)

  await withTransaction(async (connection) => {
    const lockName = hash(`mobile-device:${tokenHash}`)
    const [locks] = await connection.query<any[]>("SELECT GET_LOCK(?,5) AS acquired", [lockName])
    if (Number((locks as any[])[0]?.acquired) !== 1) throw new Error("Device registration is busy; retry")
    try {
      const [conflicts] = await connection.query<any[]>(
        "SELECT id,tenant_id,user_id,device_id,enabled FROM mobile_device_registrations WHERE token_hash=? FOR UPDATE",
        [tokenHash],
      )
      if ((conflicts as any[]).some((conflict) => Number(conflict.enabled) === 1 &&
        (Number(conflict.tenant_id) !== input.tenantId || Number(conflict.user_id) !== input.userId || conflict.device_id !== deviceId))) {
        throw new Error("Push token belongs to a different installation")
      }
      await connection.query(`INSERT INTO mobile_device_registrations
        (tenant_id,user_id,mobile_session_id,provider,token_hash,token_encrypted,device_id,app_version,device_name,platform,enabled,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,NOW())
        ON DUPLICATE KEY UPDATE mobile_session_id=VALUES(mobile_session_id),provider=VALUES(provider),token_hash=VALUES(token_hash),
        token_encrypted=VALUES(token_encrypted),device_id=VALUES(device_id),user_id=VALUES(user_id),app_version=VALUES(app_version),device_name=VALUES(device_name),platform=VALUES(platform),enabled=1,last_seen_at=NOW()`,
      [input.tenantId,input.userId,input.sessionId,provider,tokenHash,encrypted,deviceId,clean(input.appVersion,40),clean(input.deviceName,120),platform])
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {})
    }
  })
  console.info("[mobile-push] device_registered", { tenantId: input.tenantId, userId: input.userId, provider, platform })
}

export async function unregisterMobileDevice(input: { tenantId: number; userId: number; sessionId: string; deviceId?: string; token?: string }) {
  const clauses = ["tenant_id=?", "user_id=?", "mobile_session_id=?"]
  const values: unknown[] = [input.tenantId,input.userId,input.sessionId]
  if (input.deviceId) { clauses.push("device_id=?"); values.push(input.deviceId.slice(0,160)) }
  if (input.token) { clauses.push("token_hash=?"); values.push(hash(input.token.trim())) }
  if (!input.deviceId && !input.token) throw new Error("A deviceId or push token is required")
  await query(`UPDATE mobile_device_registrations SET enabled=0 WHERE ${clauses.join(" AND ")}`, values)
}

export async function deactivateMobileDeviceById(id: number, tenantId: number, userId: number) {
  await query("UPDATE mobile_device_registrations SET enabled=0 WHERE id=? AND tenant_id=? AND user_id=?", [id,tenantId,userId])
}
