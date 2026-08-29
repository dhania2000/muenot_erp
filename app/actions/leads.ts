"use server"

import { revalidatePath } from "next/cache"
import { execute } from "@/lib/db"
import { getAuthContext } from "@/lib/access"

async function assertCanEdit() {
  const ctx = await getAuthContext()
  if (!ctx) throw new Error("Not authenticated")
  if (!ctx.access.canEdit("sales", "leads")) throw new Error("You do not have edit access to Leads.")
  return ctx
}

function field(fd: FormData, key: string): string | null {
  const v = fd.get(key)
  if (v === null) return null
  const s = String(v).trim()
  return s === "" ? null : s
}

function numField(fd: FormData, key: string): number | null {
  const s = field(fd, key)
  if (s === null) return null
  const n = Number(s)
  return isNaN(n) ? null : n
}

export type LeadFormState = { error?: string; ok?: boolean }

export async function saveLead(_prev: LeadFormState, fd: FormData): Promise<LeadFormState> {
  try {
    await assertCanEdit()
  } catch (e: any) {
    return { error: e.message }
  }

  const id = field(fd, "id")
  const cols = {
    lead_code: field(fd, "lead_code") ?? `LD-${Date.now().toString().slice(-6)}`,
    contact_person: field(fd, "contact_person"),
    contact_number: field(fd, "contact_number"),
    email: field(fd, "email"),
    designation: field(fd, "designation"),
    lead_source: field(fd, "lead_source"),
    company_name: field(fd, "company_name"),
    industry: field(fd, "industry"),
    country: field(fd, "country"),
    assigned_to: field(fd, "assigned_to"),
    status: field(fd, "status") ?? "New",
    follow_up_date: field(fd, "follow_up_date"),
    health_score: numField(fd, "health_score"),
    remarks: field(fd, "remarks"),
  }

  try {
    if (id) {
      await execute(
        `UPDATE leads SET contact_person=?, contact_number=?, email=?, designation=?, lead_source=?, company_name=?, industry=?, country=?, assigned_to=?, status=?, follow_up_date=?, health_score=?, remarks=? WHERE id=?`,
        [
          cols.contact_person, cols.contact_number, cols.email, cols.designation, cols.lead_source,
          cols.company_name, cols.industry, cols.country, cols.assigned_to, cols.status,
          cols.follow_up_date, cols.health_score, cols.remarks, id,
        ],
      )
    } else {
      await execute(
        `INSERT INTO leads (lead_code, entry_date, contact_person, contact_number, email, designation, lead_source, company_name, industry, country, assigned_to, status, follow_up_date, health_score, remarks) VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          cols.lead_code, cols.contact_person, cols.contact_number, cols.email, cols.designation,
          cols.lead_source, cols.company_name, cols.industry, cols.country, cols.assigned_to,
          cols.status, cols.follow_up_date, cols.health_score, cols.remarks,
        ],
      )
    }
  } catch (e: any) {
    return { error: e?.message ?? "Failed to save lead." }
  }

  revalidatePath("/sales/leads")
  revalidatePath("/sales")
  return { ok: true }
}

export async function deleteLead(id: number) {
  await assertCanEdit()
  await execute("DELETE FROM leads WHERE id = ?", [id])
  revalidatePath("/sales/leads")
}

export async function updateLeadStatus(id: number, status: string) {
  await assertCanEdit()
  await execute("UPDATE leads SET status = ? WHERE id = ?", [status, id])
  revalidatePath("/sales/leads")
}
