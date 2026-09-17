import "server-only"
import { sendEmail } from "@/lib/email"
import { getGeneratedContract, contractPdfContext } from "@/lib/legal-contracts-generate"
import { contractPdfBuffer } from "@/lib/legal-contract-pdf"
import { logContractEvent } from "@/lib/legal-contracts-audit"
import { formatContractDate } from "@/lib/legal-contract-variables"

// ---------------------------------------------------------------------------
// Legal Contracts — email delivery (server-only, Phases 58-60 & 76).
//
// Renders the generated contract to PDF and sends it as an attachment through
// the existing shared email transport. The download link points at the
// auth-gated in-app PDF route (never a public URL). Every send — success or
// failure — is written to the contract audit trail.
// ---------------------------------------------------------------------------

function suggestRecipient(snapshot: Record<string, string> | null, partyName: string | null): string {
  const s = snapshot || {}
  return (
    s.client_email ||
    s.vendor_email ||
    s.candidate_email ||
    s.work_email ||
    s.party_email ||
    ""
  ).trim()
}

/** Suggested defaults the UI can prefill the compose form with. */
export async function contractEmailDraft(id: number): Promise<
  | { ok: true; to: string; subject: string; party: string | null }
  | { ok: false; error: string; code: number }
> {
  const contract = await getGeneratedContract(id)
  if (!contract) return { ok: false, error: "Contract not found", code: 404 }
  return {
    ok: true,
    to: suggestRecipient(contract.variables_snapshot, contract.party_name),
    subject: `${contract.contract_type}: ${contract.title}`,
    party: contract.party_name,
  }
}

export async function emailContract(
  id: number,
  input: { to?: string | null; cc?: string | null; subject?: string | null; message?: string | null; baseUrl?: string | null },
  actor: { actorId?: number | null; actorName?: string | null } = {},
): Promise<{ ok: true; to: string } | { ok: false; error: string; code: number }> {
  const contract = await getGeneratedContract(id)
  if (!contract) return { ok: false, error: "Contract not found", code: 404 }

  const to = (input.to || suggestRecipient(contract.variables_snapshot, contract.party_name)).trim()
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return { ok: false, error: "A valid recipient email is required", code: 422 }
  }

  const ctx = await contractPdfContext(contract)
  const buffer = contractPdfBuffer({
    contractUid: contract.contract_uid,
    referenceNo: contract.reference_no,
    title: contract.title,
    contractType: contract.contract_type,
    body: contract.content,
    effectiveDate: ctx.effectiveDate,
    company: ctx.company,
    firstParty: ctx.firstParty,
    secondParty: ctx.secondParty,
  })
  const filename = `${contract.reference_no?.replace(/[/\\]/g, "-") || contract.contract_uid}.pdf`

  const base = (input.baseUrl || process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "")
  const viewLink = base ? `${base}/modules/legal/contracts?open=${contract.id}` : null
  const subject = (input.subject || `${contract.contract_type}: ${contract.title}`).trim()

  const html = buildEmailHtml({
    partyName: contract.party_name,
    companyName: ctx.company.name || "our company",
    title: contract.title,
    contractType: contract.contract_type,
    reference: contract.reference_no || contract.contract_uid,
    effectiveDate: formatContractDate(contract.effective_date || contract.start_date),
    endDate: formatContractDate(contract.end_date),
    message: input.message || null,
    viewLink,
  })

  try {
    await sendEmail({
      to,
      cc: input.cc || undefined,
      subject,
      html,
      attachments: [{ filename, content: buffer, contentType: "application/pdf" }],
    })
  } catch (error) {
    await logContractEvent({
      entity: "contract",
      entityId: id,
      entityRef: contract.reference_no || contract.contract_uid,
      type: "contract_email_failed",
      summary: `Email to ${to} failed`,
      detail: { to, error: (error as Error).message },
      actorId: actor.actorId ?? null,
      actorName: actor.actorName ?? null,
    })
    return { ok: false, error: "Failed to send email. Check the mailbox configuration.", code: 502 }
  }

  // Advance status so the timeline reflects delivery (Phase 29).
  if (["Draft", "Generated", "Approved", "In Review"].includes(contract.status)) {
    await import("@/lib/db").then(({ query }) =>
      query("UPDATE legal_generated_contracts SET status = 'Sent' WHERE id = ? AND status <> 'Signed'", [id]),
    )
  }

  await logContractEvent({
    entity: "contract",
    entityId: id,
    entityRef: contract.reference_no || contract.contract_uid,
    type: "contract_emailed",
    summary: `Emailed to ${to}`,
    detail: { to, cc: input.cc || null, subject },
    actorId: actor.actorId ?? null,
    actorName: actor.actorName ?? null,
  })
  return { ok: true, to }
}

function esc(s: string | null | undefined): string {
  return String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] || c))
}

function buildEmailHtml(v: {
  partyName: string | null
  companyName: string
  title: string
  contractType: string
  reference: string
  effectiveDate: string
  endDate: string
  message: string | null
  viewLink: string | null
}): string {
  const greeting = v.partyName ? `Dear ${esc(v.partyName)},` : "Hello,"
  const body = v.message
    ? `<p style="margin:0 0 16px">${esc(v.message).replace(/\n/g, "<br>")}</p>`
    : `<p style="margin:0 0 16px">Please find attached the ${esc(v.contractType)} <strong>${esc(v.title)}</strong> from ${esc(
        v.companyName,
      )}.</p>`
  const dates =
    v.effectiveDate || v.endDate
      ? `<tr><td style="padding:4px 0;color:#64748b">Effective</td><td style="padding:4px 0;text-align:right">${esc(
          v.effectiveDate || "—",
        )}</td></tr><tr><td style="padding:4px 0;color:#64748b">Valid until</td><td style="padding:4px 0;text-align:right">${esc(
          v.endDate || "—",
        )}</td></tr>`
      : ""
  const cta = v.viewLink
    ? `<p style="margin:20px 0 0"><a href="${esc(v.viewLink)}" style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">View contract</a></p>`
    : ""
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;font-size:14px;line-height:1.6">
    <p style="margin:0 0 16px">${greeting}</p>
    ${body}
    <table style="width:100%;border-collapse:collapse;margin:16px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">
      <tr><td style="padding:4px 0;color:#64748b">Reference</td><td style="padding:4px 0;text-align:right;font-family:monospace">${esc(
        v.reference,
      )}</td></tr>
      ${dates}
    </table>
    <p style="margin:0 0 4px;color:#64748b">The signed PDF is attached to this email.</p>
    ${cta}
    <p style="margin:24px 0 0;color:#94a3b8;font-size:12px">${esc(v.companyName)}</p>
  </div>`
}
