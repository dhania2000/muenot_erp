/** Canonical SP/callback origin; never construct SSO URLs from untrusted forwarded-host headers. */
export function ssoOrigin(request?: Request): string {
  const configured = process.env.APP_URL?.trim()
  if (configured) {
    const url = new URL(configured)
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || (process.env.NODE_ENV === "production" && url.protocol !== "https:")) throw new Error("APP_URL is not a safe SSO origin")
    return url.origin
  }
  if (process.env.NODE_ENV === "production") throw new Error("APP_URL is required for SSO")
  return request ? new URL(request.url).origin : "http://localhost:3000"
}
