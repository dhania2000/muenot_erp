/**
 * Shared (client + server safe) definition of the editable careers site
 * content. Values are persisted as individual rows in the `company_settings`
 * key/value table under the `careers.` prefix, so the public careers pages and
 * the recruitment admin editor read/write the same source of truth.
 *
 * This file intentionally has no server-only imports so the admin editor
 * (client component) can share the types and defaults.
 */

export type CareersContent = {
  companyName: string
  tagline: string
  websiteUrl: string
  /** Brand/accent color (any CSS color, stored as a hex string) applied across the public careers site. */
  accentColor: string
  heroImage: string
  logoMark: string
  headerLogo: string
  aboutHeading: string
  aboutText: string
  whatWeDoHeading: string
  /** One list item per line. */
  whatWeDo: string
  teamHeading: string
  teamText: string
  footerText: string
}

/** Maps each content field to its `company_settings.skey`. */
export const CAREERS_KEYS: Record<keyof CareersContent, string> = {
  companyName: "careers.company_name",
  tagline: "careers.tagline",
  websiteUrl: "careers.website_url",
  accentColor: "careers.accent_color",
  heroImage: "careers.hero_image",
  logoMark: "careers.logo_mark",
  headerLogo: "careers.header_logo",
  aboutHeading: "careers.about_heading",
  aboutText: "careers.about_text",
  whatWeDoHeading: "careers.what_we_do_heading",
  whatWeDo: "careers.what_we_do",
  teamHeading: "careers.team_heading",
  teamText: "careers.team_text",
  footerText: "careers.footer_text",
}

export const CAREERS_DEFAULTS: CareersContent = {
  companyName: "Muenot",
  tagline: "Infinite Learning, Endless Possibilities",
  websiteUrl: "https://muenot.co.in",
  accentColor: "#2563eb",
  heroImage: "/careers-hero.png",
  logoMark: "/muenot-mark.png",
  headerLogo: "/muenot-logo.png",
  aboutHeading: "About Us",
  aboutText:
    "Muenot is a learning-first organisation on a mission to make quality education accessible to everyone. We build content, platforms and programs that help learners grow and help businesses upskill their teams. Our focus on quality, mentorship and outcomes has made us a trusted name for infinite learning.",
  whatWeDoHeading: "What We Do",
  whatWeDo: [
    "Curriculum & content: expertly crafted learning material across domains.",
    "Learning platform: an easy-to-use environment that simplifies studying and tracking progress.",
    "Mentorship: guidance from subject-matter experts to help learners stay ahead.",
    "Training & support: onboarding and support to ensure successful adoption of our programs.",
  ].join("\n"),
  teamHeading: "Our Team",
  teamText:
    "Muenot is powered by a talented and dedicated team of educators, engineers and creators. Our people bring a diverse set of skills and experiences to the table, allowing us to tackle complex challenges and deliver learning experiences that truly make a difference. We are committed to fostering a positive, collaborative environment where everyone has the opportunity to grow and succeed.",
  footerText: "By Muenot · Powered by Muenot ERP",
}

/** Resolve effective content from a settings map (saved values over defaults). */
export function resolveCareersContent(map: Record<string, string> | undefined): CareersContent {
  const out = { ...CAREERS_DEFAULTS }
  if (!map) return out
  for (const field of Object.keys(CAREERS_KEYS) as (keyof CareersContent)[]) {
    const raw = map[CAREERS_KEYS[field]]
    if (raw != null && String(raw).trim() !== "") out[field] = String(raw)
  }
  return out
}

/** Convert a content object into the `{ skey: svalue }` map for persistence. */
export function careersContentToValues(content: Partial<CareersContent>): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of Object.keys(CAREERS_KEYS) as (keyof CareersContent)[]) {
    if (field in content && content[field] != null) {
      values[CAREERS_KEYS[field]] = String(content[field])
    }
  }
  return values
}

/** Split the multiline "what we do" field into displayable list items. */
export function whatWeDoItems(content: CareersContent): string[] {
  return content.whatWeDo
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}
