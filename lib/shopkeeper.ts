import "server-only"
import { query } from "@/lib/db"
import { getTenantEntitlements } from "@/lib/platform/entitlement-guard"

export const SHOPKEEPER_FEATURES = ["mobile_app", "whatsapp", "inbox", "contacts", "templates", "campaigns", "automations", "products", "orders", "team", "notifications", "subscription", "settings"] as const
export type ShopkeeperFeature = (typeof SHOPKEEPER_FEATURES)[number]

export type ShopkeeperProfile = {
  tenantId: number; shopName: string; ownerName: string | null; businessCategory: string | null
  email: string | null; phone: string | null; address: string | null; city: string | null
  state: string | null; pinCode: string | null; country: string | null; logoUrl: string | null
  businessHours: Record<string, unknown> | null; timezone: string | null; currency: string | null
  gstin: string | null; website: string | null
}

let ensured: Promise<void> | undefined
export function ensureShopkeeperSchema() {
  return ensured ??= query(`CREATE TABLE IF NOT EXISTS shopkeeper_profiles (
    tenant_id INT UNSIGNED NOT NULL, shop_name VARCHAR(150) NOT NULL, owner_name VARCHAR(150) NULL,
    business_category VARCHAR(120) NULL, email VARCHAR(190) NULL, phone VARCHAR(40) NULL, address VARCHAR(500) NULL,
    city VARCHAR(120) NULL, state VARCHAR(120) NULL, pin_code VARCHAR(20) NULL, country VARCHAR(120) NULL,
    logo_url VARCHAR(500) NULL, business_hours JSON NULL, timezone VARCHAR(80) NULL, currency VARCHAR(12) NULL,
    gstin VARCHAR(32) NULL, website VARCHAR(255) NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id), CONSTRAINT fk_shopkeeper_profile_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`).then(() => undefined).catch(error => { ensured = undefined; throw error })
}

function map(row: any): ShopkeeperProfile {
  let businessHours: Record<string, unknown> | null = null
  try { businessHours = typeof row.business_hours === "string" ? JSON.parse(row.business_hours) : row.business_hours } catch { /* corrupt optional configuration is omitted */ }
  return { tenantId: Number(row.tenant_id), shopName: row.shop_name, ownerName: row.owner_name, businessCategory: row.business_category, email: row.email, phone: row.phone, address: row.address, city: row.city, state: row.state, pinCode: row.pin_code, country: row.country, logoUrl: row.logo_url, businessHours, timezone: row.timezone, currency: row.currency, gstin: row.gstin, website: row.website }
}

export async function getShopkeeperProfile(tenantId: number): Promise<ShopkeeperProfile | null> {
  await ensureShopkeeperSchema()
  const rows = await query<any[]>("SELECT * FROM shopkeeper_profiles WHERE tenant_id = ? LIMIT 1", [tenantId])
  return rows[0] ? map(rows[0]) : null
}

const FIELDS: Record<string, string> = { shopName: "shop_name", ownerName: "owner_name", businessCategory: "business_category", email: "email", phone: "phone", address: "address", city: "city", state: "state", pinCode: "pin_code", country: "country", logoUrl: "logo_url", timezone: "timezone", currency: "currency", gstin: "gstin", website: "website" }
export async function upsertShopkeeperProfile(tenantId: number, patch: Record<string, unknown>, fallbackName: string): Promise<ShopkeeperProfile> {
  await ensureShopkeeperSchema()
  const entries = Object.entries(FIELDS).filter(([key]) => patch[key] !== undefined).map(([key, column]) => [column, typeof patch[key] === "string" ? String(patch[key]).trim().slice(0, 500) || null : null] as const)
  const hours = patch.businessHours && typeof patch.businessHours === "object" ? JSON.stringify(patch.businessHours) : null
  const existing = await getShopkeeperProfile(tenantId)
  if (!existing) {
    const shopName = typeof patch.shopName === "string" && patch.shopName.trim() ? patch.shopName.trim().slice(0, 150) : fallbackName
    await query("INSERT INTO shopkeeper_profiles (tenant_id,shop_name,business_hours) VALUES (?,?,?)", [tenantId, shopName, hours])
  }
  const sets = entries.filter(([column]) => column !== "shop_name").map(([column]) => `\`${column}\` = ?`)
  const values = entries.filter(([column]) => column !== "shop_name").map(([, value]) => value)
  if (hours) { sets.push("business_hours = ?"); values.push(hours) }
  if (typeof patch.shopName === "string" && patch.shopName.trim()) { sets.push("shop_name = ?"); values.push(patch.shopName.trim().slice(0, 150)) }
  if (sets.length) await query(`UPDATE shopkeeper_profiles SET ${sets.join(", ")} WHERE tenant_id = ?`, [...values, tenantId])
  return (await getShopkeeperProfile(tenantId))!
}

/** Server-side plan gate; a mobile UI must never be the authorization source. */
export async function requireShopkeeperFeature(tenantId: number, feature: ShopkeeperFeature) {
  const entitlements = await getTenantEntitlements(tenantId)
  const key = `shopkeeper.${feature}`
  if (!entitlements.feature_flags.includes("shopkeeper.mobile_app") || !entitlements.feature_flags.includes(key)) {
    return { ok: false as const, status: 403, reason: `Your plan does not include Shopkeeper ${feature.replace(/_/g, " ")}.` }
  }
  return { ok: true as const }
}
