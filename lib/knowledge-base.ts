import sanitizeHtmlLib from "sanitize-html"
import { query } from "./db"
import type { SessionPayload } from "./auth"
import { userHasFeature } from "./permissions"
import { isEmailConfigured, sendEmail } from "./email"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const CONTENT_TYPES = [
  "article", "sop", "policy", "faq", "guide", "template", "training", "announcement",
] as const
export type ContentType = (typeof CONTENT_TYPES)[number]

export const STATUSES = [
  "draft", "in_review", "scheduled", "published", "expired", "archived", "rejected",
] as const
export type Status = (typeof STATUSES)[number]

export const AUDIENCE_TYPES = [
  "all", "department", "designation", "employees", "management", "admin",
] as const
export type AudienceType = (typeof AUDIENCE_TYPES)[number]

export const TO_TYPES = ["employees", "clients"] as const
export type ToType = (typeof TO_TYPES)[number]

export const DEFAULT_CATEGORIES = [
  "General", "HR", "Finance", "IT", "Operations", "Sales", "Recruitment",
  "Legal", "Compliance", "Quality", "Security", "Training", "Policies", "SOP", "FAQ", "Other",
]

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024 // 20 MB
export const ATTACHMENT_ALLOWED_EXT = [
  "pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx",
  "png", "jpg", "jpeg", "gif", "webp", "zip",
]

export type AudienceConfig = {
  departments?: string[]
  designations?: string[]
  employeeIds?: number[]
}

// ---------------------------------------------------------------------------
// Rich-text sanitization (Phase 6, 77) — allowlist only, prevents stored XSS.
// ---------------------------------------------------------------------------
export function sanitizeContent(dirty: unknown): string {
  const raw = typeof dirty === "string" ? dirty : ""
  if (!raw.trim()) return ""
  return sanitizeHtmlLib(raw, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "p", "br", "hr", "blockquote",
      "strong", "b", "em", "i", "u", "s", "code", "pre",
      "ul", "ol", "li", "a", "img",
      "table", "thead", "tbody", "tr", "th", "td",
      "span", "div",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt", "title"],
      span: ["class"],
      div: ["class"],
      code: ["class"],
      "*": ["style"],
    },
    allowedStyles: {
      "*": {
        "text-align": [/^(left|right|center|justify)$/],
        "font-weight": [/^(bold|[1-9]00)$/],
        "font-style": [/^italic$/],
      },
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    // Force safe link behavior and block javascript: URLs.
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href || ""
        const safe = /^(https?:|mailto:|tel:|\/)/i.test(href)
        const safeAttribs: Record<string, string> = safe
          ? { href, target: "_blank", rel: "noopener noreferrer nofollow" }
          : {}
        return { tagName: "a", attribs: safeAttribs }
      },
    },
    // Only allow same-origin/relative or https images (blob proxy).
    allowedSchemesByTag: { img: ["http", "https", "data"] },
  })
}

/** Strip all tags to a plain-text excerpt (for summaries, search, list rows). */
export function toPlainText(html: unknown, max = 300): string {
  const text = sanitizeHtmlLib(typeof html === "string" ? html : "", { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

// ---------------------------------------------------------------------------
// Schema self-healing (mirrors database/migrations/2026-10-12-upgrade-knowledge-base.sql)
// ---------------------------------------------------------------------------
let schemaReady = false

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await query<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  )
  return (rows[0]?.c ?? 0) > 0
}

async function addColumn(table: string, column: string, definition: string) {
  if (!(await columnExists(table, column))) {
    await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).catch((e) => {
      console.error(`[knowledge-base] add column ${table}.${column} failed`, e?.message)
    })
  }
}

export async function ensureKbSchema() {
  if (schemaReady) return

  // Base tables (created by 2026-09-11-add-knowledge-base.sql). Create defensively
  // so a fresh install without the migration still works.
  await query(`CREATE TABLE IF NOT EXISTS kb_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_category_name (name)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_articles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    heading VARCHAR(200) NOT NULL,
    description TEXT NOT NULL,
    category_id INT NULL,
    to_type ENUM('employees','clients') NOT NULL DEFAULT 'employees',
    created_by INT NULL,
    created_by_name VARCHAR(150) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`)

  // Categories: configurable (active + ordering).
  await addColumn("kb_categories", "active", "TINYINT(1) NOT NULL DEFAULT 1")
  await addColumn("kb_categories", "sort_order", "INT NOT NULL DEFAULT 0")
  for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
    await query("INSERT IGNORE INTO kb_categories (name, sort_order) VALUES (?, ?)", [DEFAULT_CATEGORIES[i], i + 1])
  }

  // Article lifecycle columns.
  const additions: Array<[string, string]> = [
    ["article_code", "VARCHAR(40) NULL"],
    ["content_type", "ENUM('article','sop','policy','faq','guide','template','training','announcement') NOT NULL DEFAULT 'article'"],
    ["summary", "VARCHAR(600) NULL"],
    ["content", "MEDIUMTEXT NULL"],
    ["subcategory", "VARCHAR(120) NULL"],
    ["tags", "TEXT NULL"],
    ["audience_type", "ENUM('all','department','designation','employees','management','admin') NOT NULL DEFAULT 'all'"],
    ["audience_config", "JSON NULL"],
    ["department", "VARCHAR(150) NULL"],
    ["author_id", "INT NULL"],
    ["author_name", "VARCHAR(150) NULL"],
    ["owner_id", "INT NULL"],
    ["owner_name", "VARCHAR(150) NULL"],
    ["status", "ENUM('draft','in_review','scheduled','published','expired','archived','rejected') NOT NULL DEFAULT 'draft'"],
    ["version", "INT NOT NULL DEFAULT 1"],
    ["publish_date", "DATETIME NULL"],
    ["published_at", "DATETIME NULL"],
    ["effective_date", "DATE NULL"],
    ["review_date", "DATE NULL"],
    ["expiry_date", "DATE NULL"],
    ["expired_at", "DATETIME NULL"],
    ["acknowledgement_required", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["notify_in_app", "TINYINT(1) NOT NULL DEFAULT 1"],
    ["notify_email", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["pinned", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["keep_pinned_after_expiry", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["important", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["view_count", "INT NOT NULL DEFAULT 0"],
    ["helpful_count", "INT NOT NULL DEFAULT 0"],
    ["not_helpful_count", "INT NOT NULL DEFAULT 0"],
    ["recipients_finalized", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["reviewer_id", "INT NULL"],
    ["reviewer_name", "VARCHAR(150) NULL"],
    ["reviewed_at", "DATETIME NULL"],
    ["review_note", "VARCHAR(1000) NULL"],
    ["reject_reason", "VARCHAR(1000) NULL"],
    ["source_module", "VARCHAR(60) NULL"],
    ["source_record_id", "VARCHAR(80) NULL"],
    ["duplicated_from", "INT NULL"],
    ["updated_by", "INT NULL"],
    ["updated_by_name", "VARCHAR(150) NULL"],
  ]

  const statusJustAdded = !(await columnExists("kb_articles", "status"))
  for (const [col, def] of additions) await addColumn("kb_articles", col, def)

  if (statusJustAdded) {
    // Existing articles were already live for their audience — keep them visible.
    await query(
      `UPDATE kb_articles
          SET status = 'published',
              published_at = COALESCE(published_at, created_at),
              publish_date = COALESCE(publish_date, created_at),
              content = COALESCE(NULLIF(content, ''), description),
              author_id = COALESCE(author_id, created_by),
              author_name = COALESCE(author_name, created_by_name),
              owner_id = COALESCE(owner_id, created_by),
              owner_name = COALESCE(owner_name, created_by_name)`,
    ).catch(() => {})
  }
  // Backfill content from legacy description for any row missing it.
  await query(`UPDATE kb_articles SET content = description WHERE (content IS NULL OR content = '') AND description IS NOT NULL`).catch(() => {})
  // Backfill article codes.
  await query(
    `UPDATE kb_articles SET article_code = CONCAT('KB-', YEAR(created_at), '-', LPAD(id, 6, '0'))
     WHERE article_code IS NULL OR article_code = ''`,
  ).catch(() => {})

  const indexes = [
    "CREATE UNIQUE INDEX uniq_kb_article_code ON kb_articles (article_code)",
    "CREATE INDEX idx_kb_status ON kb_articles (status)",
    "CREATE INDEX idx_kb_content_type ON kb_articles (content_type)",
    "CREATE INDEX idx_kb_category ON kb_articles (category_id)",
    "CREATE INDEX idx_kb_pinned ON kb_articles (pinned)",
    "CREATE INDEX idx_kb_publish_date ON kb_articles (publish_date)",
    "CREATE INDEX idx_kb_expiry_date ON kb_articles (expiry_date)",
    "CREATE INDEX idx_kb_review_date ON kb_articles (review_date)",
  ]
  for (const sql of indexes) await query(sql).catch(() => {})

  // Companion tables.
  await query(`CREATE TABLE IF NOT EXISTS kb_tags (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    tag VARCHAR(60) NOT NULL,
    UNIQUE KEY uniq_kb_tag (article_id, tag),
    KEY idx_kb_tag (tag)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_recipients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_recipient (article_id, employee_id),
    KEY idx_kbr_employee (employee_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_reads (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_read (article_id, employee_id),
    KEY idx_kbrd_employee (employee_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_acknowledgements (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    acknowledged_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_ack (article_id, employee_id),
    KEY idx_kback_employee (employee_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_attachments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NULL,
    draft_key VARCHAR(64) NULL,
    file_name VARCHAR(255) NOT NULL,
    file_type VARCHAR(150) NULL,
    file_size INT NOT NULL DEFAULT 0,
    storage_url VARCHAR(1024) NOT NULL,
    uploaded_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_kba_article (article_id),
    KEY idx_kba_draft (draft_key)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_audit (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NULL,
    user_id INT NULL,
    user_name VARCHAR(150) NULL,
    action VARCHAR(60) NOT NULL,
    detail VARCHAR(1000) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_kbaudit_article (article_id),
    KEY idx_kbaudit_action (action)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    version INT NOT NULL,
    heading VARCHAR(200) NOT NULL,
    summary VARCHAR(600) NULL,
    content MEDIUMTEXT NULL,
    category_id INT NULL,
    status VARCHAR(20) NULL,
    change_summary VARCHAR(500) NULL,
    edited_by INT NULL,
    edited_by_name VARCHAR(150) NULL,
    edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_kbv_article (article_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_deliveries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    channel ENUM('in_app','email') NOT NULL,
    status ENUM('created','sent','failed') NOT NULL DEFAULT 'created',
    error VARCHAR(500) NULL,
    attempts INT NOT NULL DEFAULT 0,
    sent_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_delivery (article_id, employee_id, channel),
    KEY idx_kbd_status (status)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_reminders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    employee_id INT UNSIGNED NULL,
    kind VARCHAR(20) NOT NULL,
    reminder_no INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_reminder (article_id, employee_id, kind, reminder_no)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_feedback (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    helpful TINYINT(1) NOT NULL,
    comment VARCHAR(1000) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_feedback (article_id, employee_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_favorites (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_favorite (article_id, employee_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_related (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    related_id INT NOT NULL,
    UNIQUE KEY uniq_kb_related (article_id, related_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_erp_links (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    source_module VARCHAR(60) NOT NULL,
    source_record_id VARCHAR(80) NOT NULL,
    label VARCHAR(200) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_kb_erp_link (article_id, source_module, source_record_id)
  )`)
  await query(`CREATE TABLE IF NOT EXISTS kb_views (
    id INT AUTO_INCREMENT PRIMARY KEY,
    article_id INT NOT NULL,
    employee_id INT UNSIGNED NOT NULL,
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_kbview_emp (employee_id, viewed_at),
    KEY idx_kbview_article (article_id)
  )`)

  schemaReady = true
}

// ---------------------------------------------------------------------------
// RBAC helpers (Phase 72). New granular grants fall back to `manage` so the
// module keeps working without extra seeding; admins always pass.
// ---------------------------------------------------------------------------
export async function canView(session: SessionPayload) {
  return userHasFeature(session.userId, session.role, "knowledge-base.view")
}
export async function canManage(session: SessionPayload) {
  return session.role === "admin" || userHasFeature(session.userId, session.role, "knowledge-base.manage")
}
export async function canApprove(session: SessionPayload) {
  if (session.role === "admin") return true
  return (
    (await userHasFeature(session.userId, session.role, "knowledge-base.approve")) ||
    (await userHasFeature(session.userId, session.role, "knowledge-base.manage"))
  )
}
export async function canViewAnalytics(session: SessionPayload) {
  if (session.role === "admin") return true
  return (
    (await userHasFeature(session.userId, session.role, "knowledge-base.analytics")) ||
    (await userHasFeature(session.userId, session.role, "knowledge-base.manage"))
  )
}
export async function canExport(session: SessionPayload) {
  if (session.role === "admin") return true
  return (
    (await userHasFeature(session.userId, session.role, "knowledge-base.export")) ||
    (await userHasFeature(session.userId, session.role, "knowledge-base.manage"))
  )
}

// ---------------------------------------------------------------------------
// Employee identity resolution (links a login user to an HR employee record)
// ---------------------------------------------------------------------------
export type EmployeeIdentity = {
  id: number
  employee_name: string
  department: string | null
  designation: string | null
  employment_status: string | null
  email: string | null
}

export async function resolveEmployee(session: SessionPayload): Promise<EmployeeIdentity | null> {
  const rows = await query<EmployeeIdentity[]>(
    `SELECT id, employee_name, department, designation, employment_status,
            COALESCE(official_email, personal_email) AS email
       FROM hr_employees
      WHERE user_id = ? OR official_email = ? OR personal_email = ?
      ORDER BY (user_id = ?) DESC
      LIMIT 1`,
    [session.userId, session.email, session.email, session.userId],
  )
  return rows[0] ?? null
}

function isActive(status: string | null | undefined) {
  return String(status ?? "").trim().toLowerCase() === "active"
}

const MANAGEMENT_KEYWORDS = ["manager", "lead", "head", "director", "vp", "chief", "cxo", "ceo", "cto", "cfo", "coo"]

// ---------------------------------------------------------------------------
// Audience resolution
// ---------------------------------------------------------------------------
export function parseAudienceConfig(raw: unknown): AudienceConfig {
  if (!raw) return {}
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as AudienceConfig } catch { return {} }
  }
  return raw as AudienceConfig
}

/** Resolve the set of ACTIVE employees for an article's audience. */
export async function resolveAudienceEmployees(article: any): Promise<EmployeeIdentity[]> {
  const cfg = parseAudienceConfig(article.audience_config)
  const where: string[] = ["1=1"]
  const params: any[] = []

  switch (article.audience_type as AudienceType) {
    case "department":
      if (cfg.departments?.length) { where.push(`department IN (${cfg.departments.map(() => "?").join(",")})`); params.push(...cfg.departments) }
      else return []
      break
    case "designation":
      if (cfg.designations?.length) { where.push(`designation IN (${cfg.designations.map(() => "?").join(",")})`); params.push(...cfg.designations) }
      else return []
      break
    case "employees":
      if (cfg.employeeIds?.length) { where.push(`id IN (${cfg.employeeIds.map(() => "?").join(",")})`); params.push(...cfg.employeeIds) }
      else return []
      break
    case "management":
      where.push(`(${MANAGEMENT_KEYWORDS.map(() => "LOWER(designation) LIKE ?").join(" OR ")})`)
      params.push(...MANAGEMENT_KEYWORDS.map((k) => `%${k}%`))
      break
    case "admin":
      where.push(`user_id IN (SELECT id FROM users WHERE role = 'admin')`)
      break
    case "all":
    default:
      break
  }

  const rows = await query<EmployeeIdentity[]>(
    `SELECT id, employee_name, department, designation, employment_status,
            COALESCE(official_email, personal_email) AS email
       FROM hr_employees WHERE ${where.join(" AND ")}`,
    params,
  )
  return rows.filter((r) => isActive(r.employment_status))
}

/** Validate a targeted audience has at least one selection. Returns error string or null. */
export function normalizeAudienceValidated(type: AudienceType, cfg: AudienceConfig): string | null {
  if (type === "all" || type === "management" || type === "admin") return null
  const map: Record<string, keyof AudienceConfig> = {
    department: "departments", designation: "designations", employees: "employeeIds",
  }
  const key = map[type]
  const arr = key ? (cfg as any)[key] : null
  if (!Array.isArray(arr) || arr.length === 0)
    return "Please select at least one target for the chosen audience type"
  return null
}

export async function previewAudience(
  audienceType: AudienceType,
  audienceConfig: AudienceConfig,
): Promise<{ count: number; sample: { id: number; name: string; department: string | null }[] }> {
  const emps = await resolveAudienceEmployees({ audience_type: audienceType, audience_config: audienceConfig })
  return {
    count: emps.length,
    sample: emps.slice(0, 8).map((e) => ({ id: e.id, name: e.employee_name, department: e.department })),
  }
}

/** Materialize the recipient list (idempotent — INSERT IGNORE). */
export async function materializeRecipients(articleId: number, article: any): Promise<number> {
  if (article.to_type === "clients") {
    await query("UPDATE kb_articles SET recipients_finalized = 1 WHERE id = ?", [articleId])
    return 0
  }
  const emps = await resolveAudienceEmployees(article)
  for (const e of emps) {
    await query("INSERT IGNORE INTO kb_recipients (article_id, employee_id) VALUES (?, ?)", [articleId, e.id])
  }
  await query("UPDATE kb_articles SET recipients_finalized = 1 WHERE id = ?", [articleId])
  return emps.length
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------
export function parseTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return dedupeTags(raw.map((t) => String(t)))
  if (typeof raw === "string") return dedupeTags(raw.split(","))
  return []
}
function dedupeTags(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of list) {
    const tag = t.trim().slice(0, 60)
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out.slice(0, 30)
}
export async function syncTags(articleId: number, tags: string[]) {
  await query("DELETE FROM kb_tags WHERE article_id = ?", [articleId])
  for (const tag of tags) {
    await query("INSERT IGNORE INTO kb_tags (article_id, tag) VALUES (?, ?)", [articleId, tag])
  }
  await query("UPDATE kb_articles SET tags = ? WHERE id = ?", [tags.join(", "), articleId])
}

// ---------------------------------------------------------------------------
// Related articles + ERP links
// ---------------------------------------------------------------------------
export async function syncRelated(articleId: number, relatedIds: number[]) {
  await query("DELETE FROM kb_related WHERE article_id = ?", [articleId])
  for (const rid of relatedIds) {
    if (rid === articleId) continue
    await query("INSERT IGNORE INTO kb_related (article_id, related_id) VALUES (?, ?)", [articleId, rid])
  }
}
export async function syncErpLinks(articleId: number, links: { source_module: string; source_record_id: string; label?: string }[]) {
  await query("DELETE FROM kb_erp_links WHERE article_id = ?", [articleId])
  for (const l of links) {
    if (!l.source_module || !l.source_record_id) continue
    await query(
      "INSERT IGNORE INTO kb_erp_links (article_id, source_module, source_record_id, label) VALUES (?, ?, ?, ?)",
      [articleId, String(l.source_module).slice(0, 60), String(l.source_record_id).slice(0, 80), (l.label ?? "").slice(0, 200) || null],
    )
  }
}

// ---------------------------------------------------------------------------
// Audit + versioning (Phase 18, 19, 71, 80)
// ---------------------------------------------------------------------------
export async function audit(articleId: number | null, session: SessionPayload | null, action: string, detail?: string) {
  await query(
    "INSERT INTO kb_audit (article_id, user_id, user_name, action, detail) VALUES (?, ?, ?, ?, ?)",
    [articleId, session?.userId ?? null, session?.name ?? null, action, detail?.slice(0, 1000) ?? null],
  ).catch((e) => console.error("[knowledge-base] audit failed", e?.message))
}

export async function snapshotVersion(article: any, session: SessionPayload | null, changeSummary?: string) {
  await query(
    `INSERT INTO kb_versions (article_id, version, heading, summary, content, category_id, status, change_summary, edited_by, edited_by_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [article.id, article.version ?? 1, article.heading, article.summary ?? null, article.content ?? article.description,
      article.category_id ?? null, article.status ?? null, changeSummary?.slice(0, 500) ?? null,
      session?.userId ?? null, session?.name ?? null],
  ).catch((e) => console.error("[knowledge-base] version snapshot failed", e?.message))
}

// ---------------------------------------------------------------------------
// Article code
// ---------------------------------------------------------------------------
export async function assignArticleCode(articleId: number) {
  await query(
    `UPDATE kb_articles SET article_code = CONCAT('KB-', YEAR(created_at), '-', LPAD(id, 6, '0'))
     WHERE id = ? AND (article_code IS NULL OR article_code = '')`,
    [articleId],
  )
}

// ---------------------------------------------------------------------------
// Publishing status derivation
// ---------------------------------------------------------------------------
export function statusForPublish(publishDate: string | null, expiryDate: string | null): Status {
  const now = Date.now()
  if (publishDate) {
    const p = new Date(publishDate.replace(" ", "T")).getTime()
    if (!Number.isNaN(p) && p > now) return "scheduled"
  }
  if (expiryDate) {
    const e = new Date(`${expiryDate}T23:59:59`).getTime()
    if (!Number.isNaN(e) && e < now) return "expired"
  }
  return "published"
}

// ---------------------------------------------------------------------------
// Notifications + Email dispatch (idempotent) — Phase 26, 27, 86, 87
// ---------------------------------------------------------------------------
function articleLink(baseUrl: string | null) {
  const base = baseUrl || process.env.NEXT_PUBLIC_APP_URL || ""
  return `${base}/modules/knowledge-base`
}

function buildEmailHtml(vars: Record<string, string>) {
  const accent = "#2563eb"
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111827">
    <div style="border-left:4px solid ${accent};padding:8px 16px;margin-bottom:16px">
      <span style="display:inline-block;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:${accent};font-weight:700">${vars.content_type || "Article"} • ${vars.category || "Knowledge Base"}</span>
      <h2 style="margin:6px 0 0;font-size:18px">${vars.title}</h2>
    </div>
    <p style="margin:0 0 12px">Hi ${vars.employee_name || "there"},</p>
    <p style="margin:0 0 12px">${vars.intro || "A knowledge base article has been published."}</p>
    ${vars.summary ? `<p style="margin:0 0 12px;color:#374151">${vars.summary}</p>` : ""}
    <a href="${vars.article_link}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">Open Article</a>
  </div>`
}

/**
 * Fan out in-app + email deliveries for a published article. Fully idempotent
 * via UNIQUE(article_id, employee_id, channel): repeated cron runs never create
 * duplicate rows and only re-attempt failed emails.
 */
export async function dispatchArticle(articleId: number, baseUrl: string | null = null) {
  const article = (await query<any[]>("SELECT * FROM kb_articles WHERE id = ? LIMIT 1", [articleId]))[0]
  if (!article || article.status !== "published") return { inApp: 0, emailSent: 0, emailFailed: 0 }

  const recipients = await query<{ employee_id: number }[]>(
    "SELECT employee_id FROM kb_recipients WHERE article_id = ?",
    [articleId],
  )

  let inApp = 0, emailSent = 0, emailFailed = 0

  if (article.notify_in_app) {
    for (const r of recipients) {
      const res: any = await query(
        `INSERT IGNORE INTO kb_deliveries (article_id, employee_id, channel, status, sent_at)
         VALUES (?, ?, 'in_app', 'sent', NOW())`,
        [articleId, r.employee_id],
      )
      if (res?.affectedRows) inApp++
    }
  }

  if (article.notify_email) {
    const emps = await query<EmployeeIdentity[]>(
      `SELECT id, employee_name, COALESCE(official_email, personal_email) AS email
         FROM hr_employees WHERE id IN (${recipients.length ? recipients.map(() => "?").join(",") : "NULL"})`,
      recipients.map((r) => r.employee_id),
    )
    const configured = isEmailConfigured()
    for (const e of emps) {
      if (!e.email) continue
      const claim: any = await query(
        `INSERT IGNORE INTO kb_deliveries (article_id, employee_id, channel, status) VALUES (?, ?, 'email', 'created')`,
        [articleId, e.id],
      )
      const row = (await query<any[]>(
        "SELECT status FROM kb_deliveries WHERE article_id = ? AND employee_id = ? AND channel = 'email' LIMIT 1",
        [articleId, e.id],
      ))[0]
      if (row?.status === "sent") continue
      if (!configured) {
        await query(
          "UPDATE kb_deliveries SET status='failed', error='SMTP not configured', attempts=attempts+1 WHERE article_id=? AND employee_id=? AND channel='email'",
          [articleId, e.id],
        )
        emailFailed++
        continue
      }
      if (!claim?.affectedRows && row?.status === "created") {
        // another worker owns it; skip to avoid duplicate email
        continue
      }
      try {
        await sendEmail({
          to: e.email,
          subject: `[Knowledge Base] ${article.heading}`,
          html: buildEmailHtml({
            employee_name: e.employee_name,
            title: article.heading,
            content_type: labelForType(article.content_type),
            category: article.category_name || "",
            summary: article.summary || "",
            article_link: articleLink(baseUrl),
          }),
        })
        await query(
          "UPDATE kb_deliveries SET status='sent', sent_at=NOW(), attempts=attempts+1, error=NULL WHERE article_id=? AND employee_id=? AND channel='email'",
          [articleId, e.id],
        )
        emailSent++
      } catch (err: any) {
        await query(
          "UPDATE kb_deliveries SET status='failed', error=?, attempts=attempts+1 WHERE article_id=? AND employee_id=? AND channel='email'",
          [String(err?.message ?? "send failed").slice(0, 500), articleId, e.id],
        )
        emailFailed++
      }
    }
  }

  return { inApp, emailSent, emailFailed }
}

export function labelForType(t: string) {
  const map: Record<string, string> = {
    article: "Article", sop: "SOP", policy: "Policy", faq: "FAQ", guide: "Guide",
    template: "Template", training: "Training", announcement: "Announcement",
  }
  return map[t] ?? "Article"
}

function fmtDate(v: string | null | undefined) {
  if (!v) return "-"
  const d = new Date(String(v).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return String(v)
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
}

// ---------------------------------------------------------------------------
// Read + acknowledgement + views + feedback + favorites (idempotent)
// ---------------------------------------------------------------------------
export async function markRead(articleId: number, employeeId: number) {
  await query("INSERT IGNORE INTO kb_reads (article_id, employee_id) VALUES (?, ?)", [articleId, employeeId])
}
export async function acknowledge(articleId: number, employeeId: number) {
  await query("INSERT IGNORE INTO kb_acknowledgements (article_id, employee_id) VALUES (?, ?)", [articleId, employeeId])
}

/** Record a view: increments the counter and stores a per-employee recent entry. */
export async function recordView(articleId: number, employeeId: number | null) {
  await query("UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ?", [articleId])
  if (employeeId) {
    await query("INSERT INTO kb_views (article_id, employee_id) VALUES (?, ?)", [articleId, employeeId])
    // Keep only the 50 most recent view rows per employee.
    await query(
      `DELETE FROM kb_views WHERE employee_id = ? AND id NOT IN (
         SELECT id FROM (SELECT id FROM kb_views WHERE employee_id = ? ORDER BY viewed_at DESC LIMIT 50) t
       )`,
      [employeeId, employeeId],
    ).catch(() => {})
  }
}

export async function setFeedback(articleId: number, employeeId: number, helpful: boolean, comment: string | null) {
  await query(
    `INSERT INTO kb_feedback (article_id, employee_id, helpful, comment) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE helpful = VALUES(helpful), comment = VALUES(comment)`,
    [articleId, employeeId, helpful ? 1 : 0, comment?.slice(0, 1000) ?? null],
  )
  await recomputeFeedback(articleId)
}
export async function recomputeFeedback(articleId: number) {
  const [row] = await query<any[]>(
    `SELECT SUM(helpful = 1) AS helpful, SUM(helpful = 0) AS not_helpful FROM kb_feedback WHERE article_id = ?`,
    [articleId],
  )
  await query("UPDATE kb_articles SET helpful_count = ?, not_helpful_count = ? WHERE id = ?", [
    Number(row?.helpful ?? 0), Number(row?.not_helpful ?? 0), articleId,
  ])
}

export async function toggleFavorite(articleId: number, employeeId: number): Promise<boolean> {
  const existing = await query<{ id: number }[]>(
    "SELECT id FROM kb_favorites WHERE article_id = ? AND employee_id = ? LIMIT 1",
    [articleId, employeeId],
  )
  if (existing.length) {
    await query("DELETE FROM kb_favorites WHERE article_id = ? AND employee_id = ?", [articleId, employeeId])
    return false
  }
  await query("INSERT IGNORE INTO kb_favorites (article_id, employee_id) VALUES (?, ?)", [articleId, employeeId])
  return true
}

// ---------------------------------------------------------------------------
// Server-side visibility (Phase 13, 75) — never rely on frontend filtering.
// ---------------------------------------------------------------------------
const VISIBLE_STATUSES = ["published", "expired", "archived"]

export async function employeeCanSee(articleId: number, emp: EmployeeIdentity | null): Promise<boolean> {
  const article = (await query<any[]>("SELECT * FROM kb_articles WHERE id = ? LIMIT 1", [articleId]))[0]
  if (!article) return false
  if (article.to_type === "clients") return false
  if (!VISIBLE_STATUSES.includes(article.status)) return false
  if (!emp) {
    return !article.recipients_finalized && article.audience_type === "all"
  }
  const rec = await query<{ id: number }[]>(
    "SELECT id FROM kb_recipients WHERE article_id = ? AND employee_id = ? LIMIT 1",
    [articleId, emp.id],
  )
  if (rec.length) return true
  if (!article.recipients_finalized) {
    if (article.audience_type === "all") return true
    if (article.audience_type === "department") {
      const cfg = parseAudienceConfig(article.audience_config)
      return !!(emp.department && cfg.departments?.includes(emp.department))
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Analytics (Phase 41, 47)
// ---------------------------------------------------------------------------
export async function getAnalytics(articleId: number) {
  const [[recipients], [reads], [acks], [emailSent], [emailFailed], [inApp], [fb]] = await Promise.all([
    query<any[]>("SELECT COUNT(*) AS c FROM kb_recipients WHERE article_id = ?", [articleId]),
    query<any[]>("SELECT COUNT(*) AS c FROM kb_reads WHERE article_id = ?", [articleId]),
    query<any[]>("SELECT COUNT(*) AS c FROM kb_acknowledgements WHERE article_id = ?", [articleId]),
    query<any[]>("SELECT COUNT(*) AS c FROM kb_deliveries WHERE article_id = ? AND channel='email' AND status='sent'", [articleId]),
    query<any[]>("SELECT COUNT(*) AS c FROM kb_deliveries WHERE article_id = ? AND channel='email' AND status='failed'", [articleId]),
    query<any[]>("SELECT COUNT(*) AS c FROM kb_deliveries WHERE article_id = ? AND channel='in_app' AND status='sent'", [articleId]),
    query<any[]>("SELECT SUM(helpful=1) AS helpful, SUM(helpful=0) AS not_helpful FROM kb_feedback WHERE article_id = ?", [articleId]),
  ])
  const totalRecipients = recipients.c ?? 0
  const readCount = reads.c ?? 0
  const ackCount = acks.c ?? 0
  return {
    totalRecipients,
    read: readCount,
    unread: Math.max(0, totalRecipients - readCount),
    acknowledged: ackCount,
    pending: Math.max(0, totalRecipients - ackCount),
    emailSent: emailSent.c ?? 0,
    emailFailed: emailFailed.c ?? 0,
    inAppSent: inApp.c ?? 0,
    helpful: Number(fb?.helpful ?? 0),
    notHelpful: Number(fb?.not_helpful ?? 0),
  }
}

/** Per-recipient read/ack breakdown for the analytics dialog. */
export async function getRecipientStatus(articleId: number) {
  return query<any[]>(
    `SELECT e.id, e.employee_name, e.department, e.designation,
            r.read_at, a.acknowledged_at
       FROM kb_recipients nr
       JOIN hr_employees e ON e.id = nr.employee_id
       LEFT JOIN kb_reads r ON r.article_id = nr.article_id AND r.employee_id = nr.employee_id
       LEFT JOIN kb_acknowledgements a ON a.article_id = nr.article_id AND a.employee_id = nr.employee_id
      WHERE nr.article_id = ?
      ORDER BY e.employee_name`,
    [articleId],
  )
}

/** Anonymized feedback list for owners/admins (Phase 43 — no identity exposed). */
export async function getFeedback(articleId: number) {
  return query<any[]>(
    `SELECT id, helpful, comment, created_at FROM kb_feedback
      WHERE article_id = ? AND (comment IS NOT NULL AND comment <> '')
      ORDER BY created_at DESC LIMIT 200`,
    [articleId],
  )
}

// ---------------------------------------------------------------------------
// Automation (cron) — Phase 22, 23, 25, 26, 27, 48, 65
// ---------------------------------------------------------------------------
export async function runKbAutomation(baseUrl: string | null = null) {
  await ensureKbSchema()
  const result = { published: 0, expired: 0, unpinned: 0, ackReminders: 0, reviewReminders: 0, emailRetried: 0, dispatched: 0 }

  // 1) Auto-publish scheduled articles whose publish time has arrived.
  const due = await query<any[]>(
    "SELECT * FROM kb_articles WHERE status = 'scheduled' AND publish_date IS NOT NULL AND publish_date <= NOW()",
  )
  for (const a of due) {
    const upd: any = await query(
      "UPDATE kb_articles SET status = 'published', published_at = NOW() WHERE id = ? AND status = 'scheduled'",
      [a.id],
    )
    if (!upd?.affectedRows) continue
    if (!a.recipients_finalized) await materializeRecipients(a.id, { ...a, status: "published" })
    await audit(a.id, null, "auto_published", "Published by scheduler")
    const d = await dispatchArticle(a.id, baseUrl)
    result.published++
    result.dispatched += d.inApp + d.emailSent
  }

  // 2) Auto-expire published articles past their expiry date (never delete).
  const expiredUpd: any = await query(
    `UPDATE kb_articles SET status = 'expired', expired_at = NOW()
     WHERE status = 'published' AND expiry_date IS NOT NULL AND expiry_date < CURDATE()`,
  )
  result.expired = expiredUpd?.affectedRows ?? 0

  // 3) Auto-unpin expired/archived articles unless flagged to stay pinned.
  const unpinUpd: any = await query(
    `UPDATE kb_articles SET pinned = 0
     WHERE pinned = 1 AND status IN ('expired','archived') AND keep_pinned_after_expiry = 0`,
  )
  result.unpinned = unpinUpd?.affectedRows ?? 0

  // 4) Retry failed emails from earlier dispatches (still-published articles).
  const retryTargets = await query<{ article_id: number }[]>(
    `SELECT DISTINCT d.article_id FROM kb_deliveries d
       JOIN kb_articles n ON n.id = d.article_id
      WHERE d.channel = 'email' AND d.status = 'failed' AND d.attempts < 5 AND n.status = 'published'`,
  )
  for (const t of retryTargets) {
    const d = await dispatchArticle(t.article_id, baseUrl)
    result.emailRetried += d.emailSent
  }

  // 5) Acknowledgement reminders for pending recipients (deduped per tier/day).
  const ackArticles = await query<any[]>(
    `SELECT * FROM kb_articles
      WHERE status = 'published' AND acknowledgement_required = 1
        AND published_at IS NOT NULL AND published_at <= (NOW() - INTERVAL 1 DAY)`,
  )
  for (const a of ackArticles) {
    const pending = await query<EmployeeIdentity[]>(
      `SELECT e.id, e.employee_name, COALESCE(e.official_email, e.personal_email) AS email
         FROM kb_recipients nr
         JOIN hr_employees e ON e.id = nr.employee_id
         LEFT JOIN kb_acknowledgements a2 ON a2.article_id = nr.article_id AND a2.employee_id = nr.employee_id
        WHERE nr.article_id = ? AND a2.id IS NULL`,
      [a.id],
    )
    const daysSince = Math.floor((Date.now() - new Date(String(a.published_at).replace(" ", "T")).getTime()) / 86400000)
    const reminderNo = Math.min(daysSince, 5)
    if (reminderNo < 1) continue
    for (const e of pending) {
      const claim: any = await query(
        "INSERT IGNORE INTO kb_reminders (article_id, employee_id, kind, reminder_no) VALUES (?, ?, 'ack', ?)",
        [a.id, e.id, reminderNo],
      )
      if (!claim?.affectedRows) continue
      result.ackReminders++
      await audit(a.id, null, "ack_reminder", `Reminder #${reminderNo} to employee ${e.id}`)
      if (a.notify_email && e.email && isEmailConfigured()) {
        try {
          await sendEmail({
            to: e.email,
            subject: `[Reminder] Please acknowledge: ${a.heading}`,
            html: buildEmailHtml({
              employee_name: e.employee_name,
              title: a.heading,
              content_type: labelForType(a.content_type),
              category: "",
              summary: a.summary || "",
              intro: "This content requires your acknowledgement. Please review and confirm.",
              article_link: articleLink(baseUrl),
            }),
          })
        } catch (err) {
          console.error("[knowledge-base] ack reminder email failed", (err as any)?.message)
        }
      }
    }
  }

  // 6) Review-date reminders to owners (one per review cycle, 7 days before).
  const reviewDue = await query<any[]>(
    `SELECT * FROM kb_articles
      WHERE status IN ('published','scheduled') AND review_date IS NOT NULL
        AND review_date <= (CURDATE() + INTERVAL 7 DAY)`,
  )
  for (const a of reviewDue) {
    // reminder_no derived from the review date so a new cycle re-notifies.
    const reminderNo = Number(String(a.review_date).replace(/-/g, "").slice(0, 8)) || 1
    const claim: any = await query(
      "INSERT IGNORE INTO kb_reminders (article_id, employee_id, kind, reminder_no) VALUES (?, ?, 'review', ?)",
      [a.id, a.owner_id ?? null, reminderNo],
    )
    if (!claim?.affectedRows) continue
    result.reviewReminders++
    await audit(a.id, null, "review_reminder", `Review due ${a.review_date}`)
    if (a.owner_id && isEmailConfigured()) {
      const owner = (await query<any[]>(
        "SELECT employee_name, COALESCE(official_email, personal_email) AS email FROM hr_employees WHERE id = ? LIMIT 1",
        [a.owner_id],
      ))[0]
      if (owner?.email) {
        try {
          await sendEmail({
            to: owner.email,
            subject: `[Review Due] ${a.heading}`,
            html: buildEmailHtml({
              employee_name: owner.employee_name,
              title: a.heading,
              content_type: labelForType(a.content_type),
              category: "",
              summary: a.summary || "",
              intro: `This ${labelForType(a.content_type)} is due for review on ${fmtDate(a.review_date)}.`,
              article_link: articleLink(baseUrl),
            }),
          })
        } catch (err) {
          console.error("[knowledge-base] review reminder email failed", (err as any)?.message)
        }
      }
    }
  }

  return result
}
