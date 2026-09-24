/**
 * SPEC 108 — Contact Management: centralized contact model (Phase 1 & 2).
 * ---------------------------------------------------------------------------
 * PHASE 1 AUDIT — duplicate contact structures found in the codebase before
 * this module existed. Each invented its own name / email / phone / address
 * shape and its own ad-hoc dedupe, so the same real-world person or company
 * was stored many times with no single source of truth:
 *
 *   - `sales_contacts`      (lib/sales/company-master.ts) — a person parented to
 *                            a Sales company account (name/title/email/phone/linkedin).
 *   - `marketing_contacts`  (lib/marketing/contacts-db.ts) — a campaign audience
 *                            member (first/last/email/phone/company/address).
 *   - `clients`             (lib/clients-db.ts) — the CRM party (person OR company)
 *                            with email/mobile/office_phone/address.
 *   - `customers_vendors`   (Finance) — the accounting party (customer AND/OR
 *                            vendor) with its own name/gstin/pan/address.
 *   - `shopkeeper_contacts` (lib/shopkeeper-contacts.ts) — retail contacts.
 *   - `legal_esign_parties` (lib/legal-esign-parties.ts) — signing parties.
 *
 * PHASE 2 — this module is the CENTRALIZED contact. A `contacts` row is the ONE
 * canonical person/company record. It supports everything the spec asks for:
 *   - Person vs Company                     -> contact_type
 *   - Role & Department                     -> role, department
 *   - Email / Phone                         -> primary + `contact_emails` / `contact_phones`
 *   - Social / contact channels             -> `contact_channels`
 *   - Customer / vendor relationship        -> is_customer / is_vendor
 *   - Multiple addresses                    -> `contact_addresses`
 *
 * Following this codebase's established rule (see clients-db.ts / company-master),
 * a contact does NOT copy the modules — it LINKS back to the canonical record it
 * represents so there is exactly one master:
 *   - client_id            -> clients.id
 *   - finance_party_id     -> customers_vendors.party_id
 *   - sales_company_id     -> sales_companies.id
 *   - sales_contact_id     -> sales_contacts.id
 *   - marketing_contact_id -> marketing_contacts.id
 *
 * This file is PURE and DB-free (no "server-only"): the SAME normalization,
 * validation and duplicate scoring runs in the browser as the user types and
 * authoritatively on the server, and is exhaustively unit-tested
 * (see test/contacts-model.test.ts). The data layer lives in db.ts.
 */

import {
  findDuplicateMatches,
  normalizeEmail as ddNormalizeEmail,
  normalizePhone as ddNormalizePhone,
  normalizeTaxId,
  type CandidateWithId,
  type DuplicateMatch,
  type EntityMatchConfig,
  type FindMatchesOptions,
  type RecordData,
} from "@/lib/duplicate-detection/model"

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

export const CONTACT_TYPES = ["Person", "Company"] as const
export type ContactType = (typeof CONTACT_TYPES)[number]

export const CONTACT_STATUSES = ["Active", "Inactive"] as const
export type ContactStatus = (typeof CONTACT_STATUSES)[number]

/** Free-form-ish channels for "social / contact channels". */
export const CHANNEL_TYPES = [
  "LinkedIn",
  "Twitter",
  "Facebook",
  "Instagram",
  "WhatsApp",
  "Telegram",
  "Skype",
  "Website",
  "Other",
] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

export const ADDRESS_TYPES = ["Billing", "Shipping", "Office", "Home", "Registered", "Other"] as const
export type AddressType = (typeof ADDRESS_TYPES)[number]

export const EMAIL_LABELS = ["Work", "Personal", "Billing", "Other"] as const
export const PHONE_LABELS = ["Work", "Mobile", "Home", "Fax", "Other"] as const

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ContactNotFoundError extends Error {
  constructor(message = "Contact not found") {
    super(message)
    this.name = "ContactNotFoundError"
  }
}

export class ContactConflictError extends Error {
  constructor(message = "This contact was modified by someone else. Refresh and try again.") {
    super(message)
    this.name = "ContactConflictError"
  }
}

// ---------------------------------------------------------------------------
// Normalization + validation helpers
// ---------------------------------------------------------------------------

export function normalizeEmail(value: unknown): string | null {
  const v = String(value ?? "").trim().toLowerCase()
  return v || null
}

export function isValidEmail(value: unknown): boolean {
  const v = String(value ?? "").trim()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
}

/** Reduce a phone number to digits (keeping a leading +) for display + storage. */
export function normalizePhone(value: unknown): string | null {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  const hasPlus = raw.startsWith("+")
  const digits = raw.replace(/[^0-9]/g, "")
  if (!digits) return null
  return (hasPlus ? "+" : "") + digits
}

export function normalizeGstin(value: unknown): string | null {
  const v = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "")
  return v || null
}

export function normalizePan(value: unknown): string | null {
  const v = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "")
  return v || null
}

export function fullNameOf(first?: unknown, last?: unknown): string {
  return [String(first ?? "").trim(), String(last ?? "").trim()].filter(Boolean).join(" ").trim()
}

/** Split a single free-text name into first / last (best effort). */
export function splitName(name: unknown): { first: string; last: string } {
  const parts = String(name ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { first: "", last: "" }
  if (parts.length === 1) return { first: parts[0], last: "" }
  return { first: parts[0], last: parts.slice(1).join(" ") }
}

/**
 * The display name for a contact: a Company shows its company name; a Person
 * shows their full name (falling back to company or email so a row is never
 * blank).
 */
export function displayNameOf(input: {
  contact_type?: unknown
  first_name?: unknown
  last_name?: unknown
  full_name?: unknown
  company_name?: unknown
  email?: unknown
}): string {
  const company = String(input.company_name ?? "").trim()
  const person =
    String(input.full_name ?? "").trim() || fullNameOf(input.first_name, input.last_name)
  const type = input.contact_type === "Company" ? "Company" : "Person"
  if (type === "Company") return company || person || String(input.email ?? "").trim() || "Untitled contact"
  return person || company || String(input.email ?? "").trim() || "Untitled contact"
}

// ---------------------------------------------------------------------------
// Writable field allow-list + payload building
// ---------------------------------------------------------------------------

/** Columns a request may set directly. Derived/owned fields are never trusted. */
export const CONTACT_WRITABLE = [
  "contact_type",
  "salutation",
  "first_name",
  "last_name",
  "company_name",
  "role",
  "department",
  "email",
  "phone",
  "is_customer",
  "is_vendor",
  "gstin",
  "pan",
  "owner_id",
  "status",
  "notes",
  "client_id",
  "finance_party_id",
  "sales_company_id",
  "sales_contact_id",
  "marketing_contact_id",
] as const

const TRUTHY = new Set(["1", "true", "yes", "on", "y"])
export function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  return TRUTHY.has(String(value ?? "").trim().toLowerCase())
}

/**
 * Build a normalized, server-owned column map for the `contacts` row from a
 * request body. Derived fields (full_name, *_normalized) are always computed
 * here so they can never be spoofed.
 */
export function buildContactColumns(body: Record<string, any>): Record<string, any> {
  const contactType: ContactType = body.contact_type === "Company" ? "Company" : "Person"
  const firstName = String(body.first_name ?? "").trim() || null
  const lastName = String(body.last_name ?? "").trim() || null
  const companyName = String(body.company_name ?? "").trim() || null
  const email = normalizeEmail(body.email)
  const phone = normalizePhone(body.phone)
  const fullName =
    contactType === "Company"
      ? companyName || fullNameOf(firstName, lastName)
      : fullNameOf(firstName, lastName) || companyName

  const out: Record<string, any> = {
    contact_type: contactType,
    salutation: String(body.salutation ?? "").trim() || null,
    first_name: firstName,
    last_name: lastName,
    full_name: fullName || "Untitled contact",
    company_name: companyName,
    role: String(body.role ?? "").trim() || null,
    department: String(body.department ?? "").trim() || null,
    email,
    email_normalized: email ? ddNormalizeEmail(email) : null,
    phone,
    phone_normalized: phone ? ddNormalizePhone(phone) : null,
    is_customer: toBool(body.is_customer) ? 1 : 0,
    is_vendor: toBool(body.is_vendor) ? 1 : 0,
    gstin: normalizeGstin(body.gstin),
    pan: normalizePan(body.pan) || panFromGstin(normalizeGstin(body.gstin)),
    status: body.status === "Inactive" ? "Inactive" : "Active",
    notes: String(body.notes ?? "").trim() || null,
    owner_id: intOrNull(body.owner_id),
    client_id: intOrNull(body.client_id),
    sales_company_id: intOrNull(body.sales_company_id),
    sales_contact_id: intOrNull(body.sales_contact_id),
    marketing_contact_id: intOrNull(body.marketing_contact_id),
    finance_party_id: String(body.finance_party_id ?? "").trim() || null,
  }
  return out
}

function intOrNull(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null
}

/** PAN is embedded in a valid GSTIN at positions 3-12. */
export function panFromGstin(gstin: string | null | undefined): string | null {
  const v = normalizeGstin(gstin)
  if (!v || v.length < 12) return null
  const pan = v.slice(2, 12)
  return /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan) ? pan : null
}

/** Validate a contact payload, returning a map of field -> message. */
export function validateContact(body: Record<string, any>): Record<string, string> {
  const errors: Record<string, string> = {}
  const contactType: ContactType = body.contact_type === "Company" ? "Company" : "Person"

  if (contactType === "Company") {
    if (!String(body.company_name ?? "").trim()) errors.company_name = "Company name is required"
  } else if (!fullNameOf(body.first_name, body.last_name)) {
    errors.first_name = "First or last name is required"
  }

  if (body.email && !isValidEmail(body.email)) errors.email = "Enter a valid email address"

  // Any additional emails must be valid too.
  if (Array.isArray(body.emails)) {
    for (const e of body.emails) {
      const val = typeof e === "string" ? e : e?.email
      if (val && !isValidEmail(val)) {
        errors.emails = "One or more additional emails are invalid"
        break
      }
    }
  }
  return errors
}

// ---------------------------------------------------------------------------
// Child collection sanitizers (emails / phones / channels / addresses)
// ---------------------------------------------------------------------------

export type ContactEmailInput = { email: string; label?: string | null; is_primary?: boolean }
export type ContactPhoneInput = { phone: string; label?: string | null; is_primary?: boolean }
export type ContactChannelInput = { channel_type: string; value: string; label?: string | null }
export type ContactAddressInput = {
  address_type?: string | null
  line1?: string | null
  line2?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  postal_code?: string | null
  is_primary?: boolean
}

export function sanitizeEmails(raw: unknown): (ContactEmailInput & { email_normalized: string })[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: (ContactEmailInput & { email_normalized: string })[] = []
  for (const item of raw) {
    const email = normalizeEmail(typeof item === "string" ? item : item?.email)
    if (!email || !isValidEmail(email)) continue
    const norm = ddNormalizeEmail(email)
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({
      email,
      email_normalized: norm,
      label: cleanLabel((item as any)?.label) || "Work",
      is_primary: toBool((item as any)?.is_primary),
    })
  }
  ensureOnePrimary(out)
  return out
}

export function sanitizePhones(raw: unknown): (ContactPhoneInput & { phone_normalized: string })[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: (ContactPhoneInput & { phone_normalized: string })[] = []
  for (const item of raw) {
    const phone = normalizePhone(typeof item === "string" ? item : item?.phone)
    if (!phone) continue
    const norm = ddNormalizePhone(phone)
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push({
      phone,
      phone_normalized: norm,
      label: cleanLabel((item as any)?.label) || "Work",
      is_primary: toBool((item as any)?.is_primary),
    })
  }
  ensureOnePrimary(out)
  return out
}

export function sanitizeChannels(raw: unknown): ContactChannelInput[] {
  if (!Array.isArray(raw)) return []
  const out: ContactChannelInput[] = []
  for (const item of raw) {
    const value = String((item as any)?.value ?? "").trim()
    if (!value) continue
    const type = String((item as any)?.channel_type ?? "").trim() || "Other"
    out.push({
      channel_type: (CHANNEL_TYPES as readonly string[]).includes(type) ? type : "Other",
      value: value.slice(0, 255),
      label: cleanLabel((item as any)?.label),
    })
  }
  return out
}

export function sanitizeAddresses(raw: unknown): ContactAddressInput[] {
  if (!Array.isArray(raw)) return []
  const out: ContactAddressInput[] = []
  for (const item of raw) {
    const a = item as any
    const hasAny = ["line1", "line2", "city", "state", "country", "postal_code"].some(
      (k) => String(a?.[k] ?? "").trim() !== "",
    )
    if (!hasAny) continue
    const type = String(a?.address_type ?? "").trim() || "Office"
    out.push({
      address_type: (ADDRESS_TYPES as readonly string[]).includes(type) ? type : "Other",
      line1: str255(a?.line1),
      line2: str255(a?.line2),
      city: str120(a?.city),
      state: str120(a?.state),
      country: str120(a?.country),
      postal_code: String(a?.postal_code ?? "").trim().slice(0, 30) || null,
      is_primary: toBool(a?.is_primary),
    })
  }
  ensureOnePrimary(out)
  return out
}

function ensureOnePrimary(items: { is_primary?: boolean }[]): void {
  if (items.length === 0) return
  const primaries = items.filter((i) => i.is_primary)
  if (primaries.length === 0) {
    items[0].is_primary = true
  } else if (primaries.length > 1) {
    let kept = false
    for (const i of items) {
      if (i.is_primary && !kept) kept = true
      else i.is_primary = false
    }
  }
}

function cleanLabel(v: unknown): string | null {
  const s = String(v ?? "").trim().slice(0, 60)
  return s || null
}
function str255(v: unknown): string | null {
  const s = String(v ?? "").trim().slice(0, 255)
  return s || null
}
function str120(v: unknown): string | null {
  const s = String(v ?? "").trim().slice(0, 120)
  return s || null
}

// ---------------------------------------------------------------------------
// Duplicate detection (built on the shared SPEC 103 framework)
// ---------------------------------------------------------------------------

/**
 * The centralized contact carries more identity than the generic "contact"
 * config in duplicate-detection/model.ts (it also has GSTIN/PAN and a company
 * name), so it defines its own match config. Any exact email / phone / tax-id is
 * a HARD key that short-circuits to "strong" regardless of the rest.
 */
export const CONTACT_MATCH_CONFIG: EntityMatchConfig = {
  entity: "contact",
  label: "Contact",
  strongThreshold: 0.78,
  possibleThreshold: 0.5,
  matchers: [
    { field: "email", strategy: "email", weight: 3, hard: true },
    { field: "phone", strategy: "phone", weight: 2.5, hard: true },
    { field: "gstin", strategy: "taxid", weight: 3, hard: true },
    { field: "pan", strategy: "taxid", weight: 2, hard: true },
    { field: "name", strategy: "name", weight: 2.5, threshold: 0.85 },
    { field: "company", strategy: "name", weight: 1.5, threshold: 0.85 },
  ],
}

/** Map a contact-ish record (row or request body) into the match config's fields. */
export function toMatchRecord(input: Record<string, any>): RecordData {
  const name =
    String(input.full_name ?? "").trim() || fullNameOf(input.first_name, input.last_name)
  return {
    name,
    company: input.company_name ?? null,
    email: input.email ?? null,
    phone: input.phone ?? null,
    gstin: input.gstin ?? null,
    pan: input.pan ?? null,
  }
}

/**
 * Score a candidate set against a target contact and return the likely
 * duplicates strongest-first. Pure: callers fetch the candidates from the DB.
 */
export function findContactDuplicateMatches<T extends CandidateWithId>(
  target: Record<string, any>,
  candidates: readonly T[],
  options: FindMatchesOptions = {},
): DuplicateMatch<T>[] {
  return findDuplicateMatches(CONTACT_MATCH_CONFIG, toMatchRecord(target), candidates, options)
}

export { normalizeTaxId }
