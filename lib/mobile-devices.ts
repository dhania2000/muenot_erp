import "server-only"
import { createHash } from "node:crypto"
import { query } from "@/lib/db"
import { encryptToken } from "@/lib/token-crypto"

const hash = (token: string) => createHash("sha256").update(token).digest("hex")

/**
 * Device registration boundary for the future notification provider. It only
 * stores an encrypted FCM registration token; no Firebase SDK, credentials, or
 * push delivery is bundled into Phase 1.
 */
export async function registerMobileDevice(input: { tenantId: number; userId: number; sessionId: string; token: string; deviceName?: string; platform?: string }) {
  const token = input.token.trim()
  if (token.length < 20 || token.length > 4096) throw new Error("Invalid device token")
  const encrypted = encryptToken(token)
  if (!encrypted?.startsWith("enc:v1:")) throw new Error("Secure device registration is unavailable")
  await query(`INSERT INTO mobile_device_registrations (tenant_id,user_id,mobile_session_id,provider,token_hash,token_encrypted,device_name,platform,last_seen_at)
    VALUES (?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),mobile_session_id=VALUES(mobile_session_id),token_encrypted=VALUES(token_encrypted),device_name=VALUES(device_name),platform=VALUES(platform),enabled=1,last_seen_at=NOW()`,
    [input.tenantId,input.userId,input.sessionId,"fcm",hash(token),encrypted,input.deviceName?.trim().slice(0,120)||null,input.platform?.trim().slice(0,32)||null])
}
export async function unregisterMobileDevice(tenantId: number, userId: number, token: string) {
  await query("UPDATE mobile_device_registrations SET enabled=0 WHERE tenant_id=? AND user_id=? AND token_hash=?", [tenantId,userId,hash(token)])
}
