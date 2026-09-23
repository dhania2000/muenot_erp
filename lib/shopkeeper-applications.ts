import "server-only"
import type { RowDataPacket } from "mysql2"
import { createHash, randomBytes } from "node:crypto"
import { pool, query } from "@/lib/db"
import { hashPassword } from "@/lib/password"
import { ensureShopkeeperProvisioningSchema, insertShopkeeperRecords, requireShopkeeperPlan, type ProvisionActor } from "@/lib/shopkeeper-provisioning"
import { normalizePhone, validatePasswordPolicy, type NormalizedShopkeeperInput } from "@/lib/shopkeeper-provisioning-core"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { ensureNotificationEngineSchema } from "@/lib/notification-engine/schema"
import { enqueueNotification, processNotification } from "@/lib/notification-engine/service"
import { withTransaction } from "@/lib/db"

export type ApplicationStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED"
export class ApplicationError extends Error {
  constructor(message: string, public status = 400, public field?: string) { super(message) }
}
type ApplicationRow = {
  id: number; status: ApplicationStatus; business_name: string; business_category: string;
  owner_name: string; email: string; mobile: string; country: string; state: string | null;
  city: string; postal_code: string | null; password_hash: string; token_hash: string;
  tenant_id: number | null; owner_user_id: number | null; rejection_reason: string | null;
  submitted_at: string; approved_at: string | null; rejected_at: string | null;
}
type ApplicationRecord = ApplicationRow & RowDataPacket
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const clean = (value: unknown) => typeof value === "string" ? value.trim() : ""
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

let ensured: Promise<void> | undefined
export function ensureShopkeeperApplicationSchema() {
  return ensured ??= (async () => {
    await ensureShopkeeperProvisioningSchema()
    await query(`CREATE TABLE IF NOT EXISTS shopkeeper_applications (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
      business_name VARCHAR(150) NOT NULL, business_category VARCHAR(120) NOT NULL,
      owner_name VARCHAR(150) NOT NULL, email VARCHAR(190) NOT NULL, mobile VARCHAR(40) NOT NULL,
      country VARCHAR(2) NOT NULL, state VARCHAR(120) NULL, city VARCHAR(120) NOT NULL, postal_code VARCHAR(20) NULL,
      password_hash VARCHAR(255) NOT NULL, token_hash CHAR(64) NOT NULL,
      terms_accepted_at DATETIME NOT NULL, privacy_accepted_at DATETIME NOT NULL,
      tenant_id INT UNSIGNED NULL, owner_user_id INT UNSIGNED NULL,
      rejection_reason VARCHAR(500) NULL, reviewed_by INT UNSIGNED NULL, submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME NULL, rejected_at DATETIME NULL,
      PRIMARY KEY(id), UNIQUE KEY uq_shopkeeper_application_email(email), UNIQUE KEY uq_shopkeeper_application_token(token_hash),
      KEY idx_shopkeeper_application_status(status,submitted_at), UNIQUE KEY uq_shopkeeper_application_mobile(mobile),
      KEY idx_shopkeeper_application_tenant(tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    await query(`CREATE TABLE IF NOT EXISTS shopkeeper_application_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, application_id BIGINT UNSIGNED NOT NULL,
      action VARCHAR(40) NOT NULL, actor_user_id INT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(id), KEY idx_shopkeeper_app_event(application_id,created_at),
      CONSTRAINT fk_shopkeeper_app_event FOREIGN KEY(application_id) REFERENCES shopkeeper_applications(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
  })().catch(error => { ensured = undefined; throw error })
}

export type PublicRegistration = {
  businessName?: unknown; businessCategory?: unknown; ownerName?: unknown; email?: unknown; mobile?: unknown;
  country?: unknown; state?: unknown; city?: unknown; postalCode?: unknown; password?: unknown;
  termsAccepted?: unknown; privacyAccepted?: unknown
}
export function validatePublicRegistration(input: PublicRegistration) {
  const businessName = clean(input.businessName)
  const businessCategory = clean(input.businessCategory)
  const ownerName = clean(input.ownerName)
  const email = clean(input.email).toLowerCase()
  const mobile = normalizePhone(input.mobile) ?? ""
  const country = clean(input.country).toUpperCase()
  const state = clean(input.state)
  const city = clean(input.city)
  const postalCode = clean(input.postalCode)
  const password = typeof input.password === "string" ? input.password : ""
  if (businessName.length < 2 || businessName.length > 150) throw new ApplicationError("Valid business name is required.", 400, "businessName")
  if (!businessCategory || businessCategory.length > 120) throw new ApplicationError("Business category is required.", 400, "businessCategory")
  if (ownerName.length < 2 || ownerName.length > 150) throw new ApplicationError("Valid owner name is required.", 400, "ownerName")
  if (email.length > 190 || !EMAIL.test(email)) throw new ApplicationError("Valid email is required.", 400, "email")
  if (!/^\+?[0-9]{7,20}$/.test(mobile)) throw new ApplicationError("Valid mobile number is required.", 400, "mobile")
  if (!/^[A-Z]{2}$/.test(country)) throw new ApplicationError("Two-letter country code is required.", 400, "country")
  if (country === "IN" && !state) throw new ApplicationError("State is required.", 400, "state")
  if (state.length > 120 || city.length < 2 || city.length > 120) throw new ApplicationError("Valid city and state are required.", 400, "city")
  if (postalCode.length > 20 || (country === "IN" && postalCode && !/^[0-9]{6}$/.test(postalCode))) throw new ApplicationError("Invalid postal code.", 400, "postalCode")
  const passwordError = validatePasswordPolicy(password)
  if (passwordError) throw new ApplicationError(passwordError, 400, "password")
  if (input.termsAccepted !== true || input.privacyAccepted !== true) throw new ApplicationError("Terms and privacy acceptance are required.", 400, "termsAccepted")
  return { businessName, businessCategory, ownerName, email, mobile, country, state: state || null, city, postalCode: postalCode || null, password }
}

export async function registerShopkeeper(input: PublicRegistration) {
  const value = validatePublicRegistration(input)
  await ensureShopkeeperApplicationSchema()
  const [user] = await query<{ id: number }[]>("SELECT id FROM users WHERE email=? OR mobile=? LIMIT 1", [value.email, value.mobile])
  if (user) throw new ApplicationError("An account with this email or mobile already exists.", 409)
  const token = randomBytes(32).toString("base64url")
  const passwordHash = await hashPassword(value.password)
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query<import("mysql2").ResultSetHeader>(
      `INSERT INTO shopkeeper_applications
       (business_name,business_category,owner_name,email,mobile,country,state,city,postal_code,password_hash,token_hash,terms_accepted_at,privacy_accepted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
      [value.businessName,value.businessCategory,value.ownerName,value.email,value.mobile,value.country,value.state,value.city,value.postalCode,passwordHash,digest(token)],
    )
    await conn.query("INSERT INTO shopkeeper_application_events (application_id,action) VALUES (?,'registered')", [result.insertId])
    await conn.commit()
    return { applicationId: Number(result.insertId), status: "PENDING_APPROVAL" as const, registrationToken: token }
  } catch (error) {
    await conn.rollback().catch(() => {})
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new ApplicationError("An application with this email already exists.", 409, "email")
    throw error
  } finally { conn.release() }
}

function publicApplication(row: ApplicationRow) {
  return { id: Number(row.id), status: row.status, businessName: row.business_name, businessCategory: row.business_category,
    ownerName: row.owner_name, email: row.email, mobile: row.mobile, country: row.country, state: row.state,
    city: row.city, postalCode: row.postal_code, submittedAt: row.submitted_at,
    approvedAt: row.approved_at, rejectedAt: row.rejected_at, rejectionReason: row.rejection_reason, tenantId: row.tenant_id }
}
export async function getRegistrationStatus(token: string) {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new ApplicationError("Invalid registration token.", 401)
  await ensureShopkeeperApplicationSchema()
  const [row] = await query<ApplicationRow[]>("SELECT * FROM shopkeeper_applications WHERE token_hash=? LIMIT 1", [digest(token)])
  if (!row) throw new ApplicationError("Registration not found.", 404)
  const result = publicApplication(row)
  const [tenant] = row.status === "APPROVED" && row.tenant_id
    ? await query<{ status: string }[]>("SELECT status FROM tenants WHERE id=? LIMIT 1", [row.tenant_id]) : []
  return { status: tenant?.status === "suspended" ? "SUSPENDED" : result.status, businessName: result.businessName, ownerName: result.ownerName,
    submittedAt: result.submittedAt, rejectionReason: result.rejectionReason }
}
export async function listApplications() {
  await ensureShopkeeperApplicationSchema()
  const rows = await query<ApplicationRow[]>("SELECT * FROM shopkeeper_applications ORDER BY submitted_at DESC,id DESC LIMIT 500")
  return rows.map(publicApplication)
}
export async function getApplication(id: number) {
  await ensureShopkeeperApplicationSchema()
  const [row] = await query<ApplicationRow[]>("SELECT * FROM shopkeeper_applications WHERE id=? LIMIT 1", [id])
  if (!row) throw new ApplicationError("Application not found.", 404)
  return publicApplication(row)
}

async function notifyApproved(tenantId: number, userId: number, applicationId: number) {
  try {
    await ensureNotificationEngineSchema()
    const ids = await withTransaction(async conn => [
      await enqueueNotification(conn, { tenantId, userId, channel: "in_app", key: `shopkeeper-approved:${applicationId}`, title: "Account approved", body: "Your Muenot Shopkeeper account has been approved." }),
      await enqueueNotification(conn, { tenantId, userId, channel: "push", key: `shopkeeper-approved:${applicationId}`, title: "Account approved", body: "Your Muenot Shopkeeper account has been approved." }),
    ])
    await Promise.all(ids.map(id => processNotification(id)))
  } catch { /* a notification must never roll back an approved account */ }
}

export async function approveApplication(id: number, planCode: string, startTrial: boolean, actor: ProvisionActor) {
  await ensureShopkeeperApplicationSchema()
  const plan = await requireShopkeeperPlan(planCode)
  const conn = await pool.getConnection()
  let created: Awaited<ReturnType<typeof insertShopkeeperRecords>> | null = null
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<ApplicationRecord[]>("SELECT * FROM shopkeeper_applications WHERE id=? FOR UPDATE", [id])
    const row = rows[0]
    if (!row) throw new ApplicationError("Application not found.", 404)
    if (row.status === "APPROVED") { await conn.commit(); return { application: publicApplication(row), alreadyApproved: true } }
    if (row.status !== "PENDING_APPROVAL") throw new ApplicationError("Reopen this application before approval.", 409)
    const [existing] = await conn.query<(RowDataPacket & { id: number })[]>("SELECT id FROM users WHERE email=? OR mobile=? LIMIT 1", [row.email,row.mobile])
    if (existing[0]) throw new ApplicationError("Email or mobile already belongs to a user.", 409)
    const input: NormalizedShopkeeperInput = {
      businessName: row.business_name, displayName: row.business_name, businessMobile: row.mobile,
      country: row.country, timezone: "Asia/Kolkata", currency: "INR", ownerName: row.owner_name,
      ownerEmail: row.email, ownerMobile: row.mobile, planCode: plan.code, generatePassword: false,
      password: null, startTrial,
    }
    created = await insertShopkeeperRecords(conn, input, row.password_hash, plan, actor,
      { channel: "mobile_self_registration", businessCategory: row.business_category, state: row.state, city: row.city, postalCode: row.postal_code, emailVerified: false })
    await conn.query("UPDATE shopkeeper_applications SET status='APPROVED',tenant_id=?,owner_user_id=?,reviewed_by=?,approved_at=NOW(),rejection_reason=NULL WHERE id=? AND status='PENDING_APPROVAL'", [created.tenantId,created.ownerUserId,actor.userId,id])
    await conn.query("INSERT INTO shopkeeper_application_events (application_id,action,actor_user_id) VALUES (?,'approved',?)", [id,actor.userId])
    await conn.commit()
  } catch (error) {
    await conn.rollback().catch(() => {})
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new ApplicationError("Email, mobile or shop was just registered.", 409)
    throw error
  } finally { conn.release() }
  await recordPlatformAudit({ actorUserId: actor.userId, actorEmail: actor.email, action: "approve_shopkeeper_application", targetTenantId: created!.tenantId, targetUserId: created!.ownerUserId, detail: { applicationId: id, planCode: plan.code } })
  await notifyApproved(created!.tenantId, created!.ownerUserId, id)
  return { application: await getApplication(id), alreadyApproved: false }
}

export async function rejectApplication(id: number, reason: string, actor: ProvisionActor) {
  const safeReason = clean(reason)
  if (safeReason.length < 3 || safeReason.length > 500) throw new ApplicationError("Rejection reason must be 3–500 characters.", 400, "reason")
  await ensureShopkeeperApplicationSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [rows] = await conn.query<ApplicationRecord[]>("SELECT * FROM shopkeeper_applications WHERE id=? FOR UPDATE", [id])
    if (!rows[0]) throw new ApplicationError("Application not found.", 404)
    if (rows[0].status !== "PENDING_APPROVAL") throw new ApplicationError("Only pending applications can be rejected.", 409)
    await conn.query("UPDATE shopkeeper_applications SET status='REJECTED',rejection_reason=?,reviewed_by=?,rejected_at=NOW() WHERE id=?", [safeReason,actor.userId,id])
    await conn.query("INSERT INTO shopkeeper_application_events (application_id,action,actor_user_id) VALUES (?,'rejected',?)", [id,actor.userId])
    await conn.commit()
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
  await recordPlatformAudit({ actorUserId: actor.userId, actorEmail: actor.email, action: "reject_shopkeeper_application", detail: { applicationId: id } })
  return getApplication(id)
}
export async function reopenApplication(id: number, actor: ProvisionActor) {
  await ensureShopkeeperApplicationSchema()
  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [result] = await conn.query<import("mysql2").ResultSetHeader>("UPDATE shopkeeper_applications SET status='PENDING_APPROVAL',rejection_reason=NULL,rejected_at=NULL,reviewed_by=NULL WHERE id=? AND status='REJECTED'", [id])
    if (!result.affectedRows) throw new ApplicationError("Only rejected applications can be reopened.", 409)
    await conn.query("INSERT INTO shopkeeper_application_events (application_id,action,actor_user_id) VALUES (?,'reopened',?)", [id,actor.userId])
    await conn.commit()
  } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
  await recordPlatformAudit({ actorUserId: actor.userId, actorEmail: actor.email, action: "reopen_shopkeeper_application", detail: { applicationId: id } })
  return getApplication(id)
}
