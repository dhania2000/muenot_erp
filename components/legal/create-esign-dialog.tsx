"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FileText,
  Search,
  Loader2,
  Trash2,
  GripVertical,
  UserPlus,
  ShieldCheck,
  Users,
  X,
} from "lucide-react"
import {
  signerTypeLabel,
  type EsignRequest,
  type EsignSignatory,
  type SignerType,
  type SigningType,
} from "@/lib/legal-esign-shared"
import type { GeneratedContract } from "@/lib/legal-contracts-shared"

type PartyOption = { id: string; name: string; email: string | null; mobile: string | null; subtitle: string | null }

type DraftSigner = {
  key: string
  signerType: SignerType
  refId: string | null
  signatoryId: number | null
  name: string
  email: string
  mobile: string | null
  role: string | null
}

const PARTY_KINDS: { value: SignerType; kind: string; label: string; icon: typeof Users }[] = [
  { value: "employee", kind: "employee", label: "Employee", icon: Users },
  { value: "client", kind: "client", label: "Client", icon: Users },
  { value: "vendor", kind: "vendor", label: "Vendor", icon: Users },
]

export function CreateEsignDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (request: EsignRequest, prepare: boolean) => void
}) {
  const { data: contractData, isLoading: contractsLoading } = useSWR<{ contracts: GeneratedContract[] }>(
    "/api/legal/contracts",
    fetcher,
  )
  const { data: sigData } = useSWR<{ signatories: EsignSignatory[] }>(
    "/api/legal/esign/signatories?activeOnly=1",
    fetcher,
  )
  const activeSignatories = (sigData?.signatories || []).filter((s) => s.status === "Active")

  const [contractId, setContractId] = useState<number | null>(null)
  const [contractSearch, setContractSearch] = useState("")
  const [title, setTitle] = useState("")
  const [signers, setSigners] = useState<DraftSigner[]>([])
  const [signingType, setSigningType] = useState<SigningType>("sequential")
  const [dueDate, setDueDate] = useState("")
  const [message, setMessage] = useState("")
  const [requireConfirm, setRequireConfirm] = useState(true)
  const [autoEmailSigned, setAutoEmailSigned] = useState(true)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [existingId, setExistingId] = useState<number | null>(null)

  const contracts = useMemo(() => {
    const list = contractData?.contracts || []
    const q = contractSearch.trim().toLowerCase()
    const filtered = q
      ? list.filter(
          (c) =>
            c.title.toLowerCase().includes(q) ||
            (c.reference_no || "").toLowerCase().includes(q) ||
            c.contract_uid.toLowerCase().includes(q),
        )
      : list
    return filtered.slice(0, 40)
  }, [contractData, contractSearch])

  const chosenContract = useMemo(
    () => (contractData?.contracts || []).find((c) => c.id === contractId) || null,
    [contractData, contractId],
  )

  function chooseContract(c: GeneratedContract) {
    setContractId(c.id)
    setTitle((prev) => prev || c.title)
  }

  function addSigner(s: Omit<DraftSigner, "key">) {
    setSigners((prev) => {
      if (prev.some((p) => p.email.toLowerCase() === s.email.toLowerCase())) {
        toast.error("That signer is already added")
        return prev
      }
      return [...prev, { ...s, key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }]
    })
  }

  function removeSigner(key: string) {
    setSigners((prev) => prev.filter((p) => p.key !== key))
  }

  function moveSigner(index: number, dir: -1 | 1) {
    setSigners((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const canSubmit = !!contractId && title.trim().length > 0 && signers.length > 0 && !submitting

  async function submit(prepare: boolean, force = false) {
    if (!canSubmit && !force) return
    setSubmitting(true)
    setError("")
    setExistingId(null)
    try {
      const res = await fetch("/api/legal/esign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          documentSource: "contract",
          contractId,
          signingType,
          dueDate: dueDate || null,
          message: message.trim() || null,
          requireConfirm,
          autoEmailSigned,
          force,
          signers: signers.map((s, i) => ({
            signerType: s.signerType,
            refId: s.refId,
            signatoryId: s.signatoryId,
            name: s.name,
            email: s.email,
            mobile: s.mobile,
            role: s.role,
            signingOrder: i + 1,
          })),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success("Signature request created as draft")
        onCreated(d.request as EsignRequest, prepare)
      } else if (res.status === 409 && d.existingId) {
        setError(d.error || "An open request already exists for this document")
        setExistingId(d.existingId)
      } else {
        setError(d.error || "Could not create the request")
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New signature request</DialogTitle>
          <DialogDescription>
            Pick a generated contract, add the people who must sign, then set the signing options. You can place
            signature fields before sending.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6 py-1">
          {/* Document */}
          <section className="flex flex-col gap-2">
            <Label>Document</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={contractSearch}
                onChange={(e) => setContractSearch(e.target.value)}
                placeholder="Search generated contracts…"
                className="pl-9"
              />
            </div>
            {contractsLoading ? (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading contracts…
              </div>
            ) : contracts.length === 0 ? (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                No generated contracts found. Generate one in Legal → Contracts first.
              </div>
            ) : (
              <div className="grid max-h-44 gap-1.5 overflow-y-auto">
                {contracts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => chooseContract(c)}
                    className={`flex items-center justify-between rounded-lg border p-2.5 text-left transition-colors ${
                      contractId === c.id ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-primary/50"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <FileText className="size-4 shrink-0 text-primary" />
                      <div>
                        <div className="text-sm font-medium">{c.title}</div>
                        <div className="text-xs text-muted-foreground">
                          {c.reference_no || c.contract_uid} · {c.status}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Title */}
          <section className="flex flex-col gap-2">
            <Label htmlFor="esign-title">Request title</Label>
            <Input
              id="esign-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Master Services Agreement — Acme Corp"
            />
          </section>

          {/* Signers */}
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Label>Signers ({signers.length})</Label>
            </div>
            {signers.length > 0 && (
              <ol className="flex flex-col gap-2">
                {signers.map((s, i) => (
                  <li key={s.key} className="flex items-center gap-2 rounded-lg border bg-card p-2.5">
                    {signingType === "sequential" && (
                      <div className="flex flex-col">
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                          disabled={i === 0}
                          onClick={() => moveSigner(i, -1)}
                          aria-label="Move up"
                        >
                          <GripVertical className="size-4" />
                        </button>
                      </div>
                    )}
                    <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold tabular-nums">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{s.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {s.email} · {signerTypeLabel(s.signerType)}
                        {s.role ? ` · ${s.role}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-rose-600"
                      onClick={() => removeSigner(s.key)}
                      aria-label="Remove signer"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                ))}
              </ol>
            )}
            <SignerAdder signatories={activeSignatories} onAdd={addSigner} />
          </section>

          {/* Options */}
          <section className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label>Signing order</Label>
              <Select value={signingType} onValueChange={(v) => setSigningType(v as SigningType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sequential">Sequential — one after another</SelectItem>
                  <SelectItem value="parallel">Parallel — everyone at once</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="esign-due">Due date (optional)</Label>
              <Input id="esign-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="esign-message">Message to signers (optional)</Label>
              <Textarea
                id="esign-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Add a short note included in the signing email…"
                rows={2}
              />
            </div>
            <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <span className="text-sm">
                Require confirmation
                <span className="block text-xs text-muted-foreground">Signer must tick a consent box first</span>
              </span>
              <Switch checked={requireConfirm} onCheckedChange={setRequireConfirm} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <span className="text-sm">
                Email signed copy
                <span className="block text-xs text-muted-foreground">Send the final PDF to all parties</span>
              </span>
              <Switch checked={autoEmailSigned} onCheckedChange={setAutoEmailSigned} />
            </label>
          </section>

          {error && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <p>{error}</p>
              {existingId && (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => submit(false, true)}>
                    Create a new one anyway
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={() => submit(false)} disabled={!canSubmit}>
            {submitting ? "Saving…" : "Save draft"}
          </Button>
          <Button onClick={() => submit(true)} disabled={!canSubmit}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            Save &amp; place fields
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Inline signer picker: authorized signatory · directory party · manual entry.
// ---------------------------------------------------------------------------
function SignerAdder({
  signatories,
  onAdd,
}: {
  signatories: EsignSignatory[]
  onAdd: (s: Omit<DraftSigner, "key">) => void
}) {
  const [tab, setTab] = useState<"signatory" | "party" | "manual" | null>(null)

  if (!tab) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setTab("signatory")}>
          <ShieldCheck data-icon="inline-start" /> Authorized signatory
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setTab("party")}>
          <Users data-icon="inline-start" /> From directory
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setTab("manual")}>
          <UserPlus data-icon="inline-start" /> Manual entry
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">
          {tab === "signatory" ? "Add authorized signatory" : tab === "party" ? "Add from directory" : "Add manually"}
        </span>
        <button type="button" onClick={() => setTab(null)} aria-label="Close picker" className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      {tab === "signatory" && (
        <SignatoryPicker
          signatories={signatories}
          onPick={(s) => {
            onAdd({
              signerType: "authorized_signatory",
              refId: null,
              signatoryId: s.id,
              name: s.name,
              email: s.email || "",
              mobile: null,
              role: s.designation,
            })
            setTab(null)
          }}
        />
      )}
      {tab === "party" && (
        <PartyPicker
          onPick={(kind, p) => {
            onAdd({
              signerType: kind as SignerType,
              refId: p.id,
              signatoryId: null,
              name: p.name,
              email: p.email || "",
              mobile: p.mobile,
              role: p.subtitle,
            })
            setTab(null)
          }}
        />
      )}
      {tab === "manual" && (
        <ManualSignerForm
          onAdd={(m) => {
            onAdd({ signerType: "external", refId: null, signatoryId: null, ...m })
            setTab(null)
          }}
        />
      )}
    </div>
  )
}

function SignatoryPicker({
  signatories,
  onPick,
}: {
  signatories: EsignSignatory[]
  onPick: (s: EsignSignatory) => void
}) {
  if (signatories.length === 0) {
    return (
      <p className="py-2 text-sm text-muted-foreground">
        No active authorized signatories. Add one in Legal → E-sign Settings.
      </p>
    )
  }
  return (
    <div className="grid max-h-44 gap-1.5 overflow-y-auto">
      {signatories.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => onPick(s)}
          disabled={!s.email}
          className="flex items-center justify-between rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-primary/50 disabled:opacity-50"
        >
          <div>
            <div className="text-sm font-medium">{s.name}</div>
            <div className="text-xs text-muted-foreground">
              {[s.designation, s.email || "no email on file"].filter(Boolean).join(" · ")}
            </div>
          </div>
          <span
            className={`text-xs ${s.signature_status === "Uploaded" ? "text-emerald-600" : "text-amber-600"}`}
          >
            {s.signature_status === "Uploaded" ? "Signature ready" : "No signature"}
          </span>
        </button>
      ))}
    </div>
  )
}

function PartyPicker({ onPick }: { onPick: (kind: string, p: PartyOption) => void }) {
  const [kind, setKind] = useState("employee")
  const [search, setSearch] = useState("")
  const { data, isLoading } = useSWR<{ records: PartyOption[] }>(
    `/api/legal/esign/parties?kind=${kind}&search=${encodeURIComponent(search)}`,
    fetcher,
  )
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PARTY_KINDS.map((k) => (
              <SelectItem key={k.kind} value={k.kind}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" className="pl-9" />
        </div>
      </div>
      <div className="grid max-h-40 gap-1.5 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        )}
        {(data?.records || []).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(kind, p)}
            disabled={!p.email}
            className="flex items-center justify-between rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-primary/50 disabled:opacity-50"
          >
            <div>
              <div className="text-sm font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground">
                {[p.email || "no email", p.subtitle].filter(Boolean).join(" · ")}
              </div>
            </div>
          </button>
        ))}
        {!isLoading && (data?.records || []).length === 0 && (
          <p className="py-3 text-center text-sm text-muted-foreground">No matching records.</p>
        )}
      </div>
    </div>
  )
}

function ManualSignerForm({
  onAdd,
}: {
  onAdd: (m: { name: string; email: string; mobile: string | null; role: string | null }) => void
}) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [mobile, setMobile] = useState("")
  const [role, setRole] = useState("")
  const valid = name.trim() && /.+@.+\..+/.test(email)
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
      <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" />
      <Input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="Mobile (optional)" />
      <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Role / title (optional)" />
      <div className="sm:col-span-2">
        <Button
          type="button"
          size="sm"
          disabled={!valid}
          onClick={() =>
            onAdd({ name: name.trim(), email: email.trim(), mobile: mobile.trim() || null, role: role.trim() || null })
          }
        >
          Add signer
        </Button>
      </div>
    </div>
  )
}
