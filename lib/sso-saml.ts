import "server-only"
import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml"
import { pool, query } from "@/lib/db"
import type { SsoProviderRow } from "@/lib/sso-store"

function cleanCertificate(value: string) { return value.trim().replace(/\r\n/g, "\n") }
export function samlEndpoints(provider: SsoProviderRow, origin: string) {
  const base = `${origin}/api/auth/sso/${provider.id}/saml`
  return { acs: `${base}/acs`, metadata: `${base}/metadata`, login: `${base}/login` }
}

/** Durable request-id cache gives node-saml strict InResponseTo validation across requests. */
function cache(providerId: number) {
  return {
    saveAsync: async (key: string, value: string) => {
      await query("INSERT INTO sso_saml_requests (request_id,provider_id,request_xml,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 5 MINUTE)) ON DUPLICATE KEY UPDATE request_xml=VALUES(request_xml),expires_at=VALUES(expires_at)", [key,providerId,value])
      return { value, createdAt: Date.now() }
    },
    getAsync: async (key: string) => {
      const rows = await query<any[]>("SELECT request_xml FROM sso_saml_requests WHERE request_id=? AND provider_id=? AND expires_at>UTC_TIMESTAMP() LIMIT 1", [key,providerId])
      return rows[0]?.request_xml ?? null
    },
    removeAsync: async (key: string | null) => {
      if (!key) return null
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()
        const [rows] = await conn.query<any[]>("SELECT request_xml FROM sso_saml_requests WHERE request_id=? AND provider_id=? FOR UPDATE", [key,providerId])
        if (rows[0]) await conn.query("DELETE FROM sso_saml_requests WHERE request_id=? AND provider_id=?", [key,providerId])
        await conn.commit()
        return rows[0]?.request_xml ?? null
      } catch (error) { await conn.rollback().catch(() => {}); throw error } finally { conn.release() }
    },
  }
}

export function createSaml(provider: SsoProviderRow, origin: string) {
  if (!provider.entity_id || !provider.sso_url || !provider.certificate) throw new Error("SAML Entity ID, SSO URL and certificate are required")
  const endpoints = samlEndpoints(provider, origin)
  return new SAML({
    entryPoint: provider.sso_url, idpCert: cleanCertificate(provider.certificate), idpIssuer: provider.entity_id,
    issuer: endpoints.metadata, callbackUrl: endpoints.acs, audience: endpoints.metadata,
    validateInResponseTo: ValidateInResponseTo.always, requestIdExpirationPeriodMs: 5 * 60 * 1000,
    wantAssertionsSigned: true, wantAuthnResponseSigned: true, acceptedClockSkewMs: 5000,
    disableRequestedAuthnContext: true, cacheProvider: cache(provider.id),
  })
}

function attr(profile: Profile, name: string | null, fallback: string) {
  const value = profile[name || fallback] ?? profile[fallback]
  return typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : null
}
export function mappedSamlClaims(provider: SsoProviderRow, profile: Profile) {
  const email = attr(profile, provider.email_attribute, "email") || attr(profile, provider.email_attribute, "mail") || attr(profile, provider.email_attribute, "urn:oid:0.9.2342.19200300.100.1.3")
  const first = attr(profile, provider.first_name_attribute, "givenName")
  const last = attr(profile, provider.last_name_attribute, "sn")
  return { subject: profile.nameID, email: email?.trim().toLowerCase() ?? null, name: [first,last].filter(Boolean).join(" ") || email || profile.nameID }
}
