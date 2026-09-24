import "server-only"
import { getSettings } from "@/lib/settings/server"
import type { SettingsMap } from "@/lib/settings/format"

/**
 * The effective branding for the tenant currently in context. This is a thin,
 * typed projection over the tenant-scoped settings map (see lib/settings/server
 * and lib/tenant-settings). It inherits that layer's tenant isolation and
 * short-lived caching for free: reads are scoped to the acting tenant via
 * AsyncLocalStorage, and invalidateSettingsCache() clears both.
 */
export type TenantBranding = {
  companyName: string
  appName: string
  logo: string
  loginLogo: string
  favicon: string
  website: string
  primaryColor: string
  sidebarColor: string
  loginBackground: string
  customDomain: string
  email: {
    logo: string
    headerColor: string
    buttonColor: string
    footerText: string
  }
  pdf: {
    logo: string
    accentColor: string
    footerText: string
  }
}

const DEFAULT_PRIMARY = "#6d28d9"

function pick(map: SettingsMap, key: string, fallback = ""): string {
  const v = map[key]
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback
}

/** Build the branding projection from an already-loaded settings map. */
export function brandingFromSettings(map: SettingsMap): TenantBranding {
  const companyName = pick(map, "company.name", "Muenot Business Team")
  const appName = pick(map, "app.name", companyName)
  const primaryColor = pick(map, "theme.primary_color", DEFAULT_PRIMARY)
  const companyLogo = pick(map, "company.logo")

  return {
    companyName,
    appName,
    logo: companyLogo,
    loginLogo: pick(map, "company.login_logo", companyLogo),
    favicon: pick(map, "company.favicon"),
    website: pick(map, "company.website"),
    primaryColor,
    sidebarColor: pick(map, "theme.sidebar_color", primaryColor),
    loginBackground: pick(map, "theme.login_background"),
    customDomain: pick(map, "company.custom_domain").toLowerCase(),
    email: {
      logo: pick(map, "email.brand_logo", companyLogo),
      headerColor: pick(map, "email.brand_color", primaryColor),
      buttonColor: pick(map, "email.button_color", primaryColor),
      footerText: pick(map, "email.footer_text", `© ${new Date().getFullYear()} ${companyName}. All rights reserved.`),
    },
    pdf: {
      logo: pick(map, "pdf.brand_logo", companyLogo),
      accentColor: pick(map, "pdf.accent_color", primaryColor),
      footerText: pick(map, "pdf.footer_text"),
    },
  }
}

/**
 * Resolve branding for the tenant in the current async context. Safe to call
 * many times per request — getSettings() is deduped and cached per tenant.
 */
export async function getBranding(): Promise<TenantBranding> {
  return brandingFromSettings(await getSettings())
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/**
 * Wrap a message body in a branded, email-client-safe HTML shell using the
 * tenant's email branding. Inline styles + table layout for broad client
 * support. `bodyHtml` is inserted as-is (callers own its safety).
 */
export function renderBrandedEmail(
  bodyHtml: string,
  branding: TenantBranding,
  opts: { title?: string } = {},
): string {
  const b = branding.email
  const title = escapeHtml(opts.title ?? branding.companyName)
  const logoBlock = b.logo
    ? `<img src="${escapeHtml(b.logo)}" alt="${escapeHtml(branding.companyName)}" height="40" style="height:40px;max-height:40px;border:0;display:block" />`
    : `<span style="color:#ffffff;font-size:20px;font-weight:700;">${escapeHtml(branding.companyName)}</span>`

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,Helvetica,sans-serif;color:#1f2937;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
        <tr><td style="background:${escapeHtml(b.headerColor)};padding:20px 28px;">${logoBlock}</td></tr>
        <tr><td style="padding:28px;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #eef0f4;font-size:12px;color:#8a94a6;">${escapeHtml(b.footerText)}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

/** Inline style for a branded call-to-action button in emails. */
export function emailButtonStyle(branding: TenantBranding): string {
  return `display:inline-block;background:${escapeHtml(branding.email.buttonColor)};color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:600;font-size:14px;`
}
