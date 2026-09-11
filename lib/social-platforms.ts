/**
 * Shared, secret-free social platform metadata. Safe to import from both
 * client and server. OAuth logic and credentials live in lib/social-oauth.ts
 * (server only).
 */

export type SocialPlatformId = "linkedin" | "x" | "facebook" | "instagram"

export type SocialPlatformMeta = {
  id: SocialPlatformId
  name: string
  abbr: string
  color: string
  /** max characters allowed for a post on this platform */
  limit: number
  /** whether this platform requires an image to publish */
  requiresImage: boolean
  /** short setup hint shown when credentials are missing */
  setupHint: string
}

export const SOCIAL_PLATFORMS: SocialPlatformMeta[] = [
  {
    id: "linkedin",
    name: "LinkedIn",
    abbr: "in",
    color: "#0A66C2",
    limit: 3000,
    requiresImage: false,
    setupHint:
      "Create a LinkedIn app at linkedin.com/developers and add the Sign In + Share on LinkedIn products. Personal posting works with these. Company Page posting additionally requires the Community Management API product (external LinkedIn approval), then set LINKEDIN_ORG_ENABLED=true.",
  },
  {
    id: "instagram",
    name: "Instagram",
    abbr: "Ig",
    color: "#E4405F",
    limit: 2200,
    requiresImage: true,
    setupHint:
      "Instagram uses Business Login for Instagram (INSTAGRAM_APP_ID/SECRET). Connect an Instagram professional (Business or Creator) account — no Facebook Page link required.",
  },
  {
    id: "x",
    name: "X (Twitter)",
    abbr: "X",
    color: "#111827",
    limit: 280,
    requiresImage: false,
    setupHint: "Create an app in the X Developer Portal with OAuth 2.0 and the tweet.write scope.",
  },
  {
    id: "facebook",
    name: "Facebook",
    abbr: "f",
    color: "#1877F2",
    limit: 63206,
    requiresImage: false,
    setupHint:
      "Create a Meta app (developers.facebook.com) and add pages_show_list, pages_read_engagement and pages_manage_posts. If it is a 'Facebook Login for Business' app, do NOT pass scopes — create a Login configuration and set FACEBOOK_CONFIG_ID instead (raw scopes there cause 'Invalid Scopes'). Connect a user who is an admin of the Page.",
  },
]

export function getSocialPlatform(id: SocialPlatformId) {
  return SOCIAL_PLATFORMS.find((p) => p.id === id)!
}
