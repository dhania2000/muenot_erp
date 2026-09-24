"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Download,
  Eye,
  Upload,
  Trash2,
  Link2,
  Copy,
  Check,
  X,
  Send,
  Clock,
  ShieldCheck,
} from "lucide-react"
import type {
  DmsDocument,
  DmsDocumentFile,
  DmsPermission,
  DmsShare,
  DmsAuditEntry,
  DmsFolder,
  DmsCategory,
  DmsTag,
} from "@/lib/dms/types"
import type { AccessLevel, DocWorkflowType } from "@/lib/dms/model"
import { canPerform, DOC_WORKFLOW_TYPES, workflowLabel } from "@/lib/dms/model"

type DetailResponse = {
  document: DmsDocument
  access: AccessLevel
  versions: DmsDocumentFile[]
  permissions: DmsPermission[]
  shares: (DmsShare & { url?: string })[]
  audit: DmsAuditEntry[]
}

export function DocumentDetailSheet({
  docId,
  folders,
  categories,
  knownTags,
  currentUserId,
  onClose,
  onChanged,
}: {
  docId: number
  folders: DmsFolder[]
  categories: DmsCategory[]
  knownTags: DmsTag[]
  currentUserId: number
  onClose: () => void
  onChanged: () => void
}) {
  const { data, isLoading, mutate } = useSWR<DetailResponse>(`/api/dms/documents/${docId}`, fetcher)
  const doc = data?.document
  const access = data?.access ?? null

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <SheetHeader className="border-b p-6">
          <SheetTitle className="pr-8">{doc?.title ?? "Document"}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{doc?.docRef}</SheetDescription>
        </SheetHeader>

        {isLoading || !doc ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <Tabs defaultValue="details" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-6 mt-4 flex w-auto flex-wrap justify-start">
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="versions">Versions</TabsTrigger>
                {canPerform("manage_permissions", access) && <TabsTrigger value="permissions">Permissions</TabsTrigger>}
                {canPerform("share", access) && <TabsTrigger value="sharing">Sharing</TabsTrigger>}
                <TabsTrigger value="audit">Audit</TabsTrigger>
              </TabsList>

              <div className="min-h-0 flex-1 overflow-auto p-6">
                <TabsContent value="details" className="mt-0">
                  <DetailsTab
                    doc={doc}
                    access={access}
                    folders={folders}
                    categories={categories}
                    onChanged={() => {
                      mutate()
                      onChanged()
                    }}
                    onDeleted={() => {
                      onChanged()
                      onClose()
                    }}
                  />
                </TabsContent>

                <TabsContent value="versions" className="mt-0">
                  <VersionsTab
                    doc={doc}
                    versions={data.versions}
                    access={access}
                    onChanged={() => {
                      mutate()
                      onChanged()
                    }}
                  />
                </TabsContent>

                {canPerform("manage_permissions", access) && (
                  <TabsContent value="permissions" className="mt-0">
                    <PermissionsTab docId={doc.id} permissions={data.permissions} onChanged={mutate} />
                  </TabsContent>
                )}

                {canPerform("share", access) && (
                  <TabsContent value="sharing" className="mt-0">
                    <SharingTab docId={doc.id} shares={data.shares} onChanged={mutate} />
                  </TabsContent>
                )}

                <TabsContent value="audit" className="mt-0">
                  <AuditTab audit={data.audit} />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function DetailsTab({
  doc,
  access,
  folders,
  categories,
  onChanged,
  onDeleted,
}: {
  doc: DmsDocument
  access: AccessLevel | null
  folders: DmsFolder[]
  categories: DmsCategory[]
  onChanged: () => void
  onDeleted: () => void
}) {
  const editable = canPerform("edit", access)
  const [title, setTitle] = useState(doc.title)
  const [description, setDescription] = useState(doc.description ?? "")
  const [folderId, setFolderId] = useState(doc.folderId == null ? "root" : String(doc.folderId))
  const [categoryId, setCategoryId] = useState(doc.categoryId == null ? "none" : String(doc.categoryId))
  const [status, setStatus] = useState(doc.status)
  const [expiresAt, setExpiresAt] = useState(doc.expiresAt ? doc.expiresAt.slice(0, 10) : "")
  const [tags, setTags] = useState((doc.tags ?? []).map((t) => t.name).join(", "))
  const [busy, setBusy] = useState(false)

  async function save() {
    setBusy(true)
    try {
      const res = await fetch(`/api/dms/documents/${doc.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          folderId: folderId === "root" ? null : Number(folderId),
          categoryId: categoryId === "none" ? null : Number(categoryId),
          status,
          expiresAt: expiresAt || null,
          tags,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Save failed")
      toast.success("Document updated")
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      const res = await fetch(`/api/dms/documents/${doc.id}`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Delete failed")
      toast.success("Document deleted")
      onDeleted()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-1.5">
        <Label>Title</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} />
      </div>
      <div className="grid gap-1.5">
        <Label>Description</Label>
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} disabled={!editable} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label>Folder</Label>
          <Select value={folderId} onValueChange={setFolderId} disabled={!editable}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="root">Unfiled</SelectItem>
              {folders.map((f) => (
                <SelectItem key={f.id} value={String(f.id)}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Category</Label>
          <Select value={categoryId} onValueChange={setCategoryId} disabled={!editable}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="grid gap-1.5">
          <Label>Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as typeof status)} disabled={!editable}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>Expires</Label>
          <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} disabled={!editable} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label>Tags</Label>
        <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma,separated" disabled={!editable} />
      </div>

      <Separator />

      <ApprovalControls doc={doc} access={access} onChanged={onChanged} />

      {editable && (
        <div className="flex items-center justify-between gap-2 pt-2">
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save changes"}
          </Button>
          {canPerform("delete", access) && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" disabled={busy}>
                  <Trash2 className="mr-1.5 size-4" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this document?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The document will be archived and hidden from listings. This can be reversed by an administrator.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={remove}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      )}
    </div>
  )
}

function ApprovalControls({
  doc,
  access,
  onChanged,
}: {
  doc: DmsDocument
  access: AccessLevel | null
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [workflowType, setWorkflowType] = useState<DocWorkflowType>(
    (doc.workflowType as DocWorkflowType) ?? DOC_WORKFLOW_TYPES[0].key,
  )
  const canApprove = canPerform("approve", access)
  const canEdit = canPerform("edit", access)

  async function act(action: string, extra?: Record<string, unknown>) {
    setBusy(true)
    try {
      const res = await fetch(`/api/dms/documents/${doc.id}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Action failed")
      toast.success("Approval updated")
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const isPending = doc.approvalStatus === "pending"
  const canSubmit = canEdit && !isPending && (doc.status === "draft" || doc.status === "rejected")

  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-medium">
        <ShieldCheck className="size-4" /> Approval
        <Badge variant="outline" className="ml-1 capitalize">
          {doc.status}
        </Badge>
        {doc.workflowType && (
          <Badge variant="secondary" className="ml-1">
            {workflowLabel(doc.workflowType)}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canSubmit && (
          <>
            <Select value={workflowType} onValueChange={(v) => setWorkflowType(v as DocWorkflowType)}>
              <SelectTrigger className="h-8 w-[180px]">
                <SelectValue placeholder="Workflow" />
              </SelectTrigger>
              <SelectContent>
                {DOC_WORKFLOW_TYPES.map((t) => (
                  <SelectItem key={t.key} value={t.key}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act("submit", { workflowType })}>
              <Send className="mr-1 size-3.5" /> Submit for approval
            </Button>
          </>
        )}
        {canApprove && isPending && (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act("approve")}>
              <Check className="mr-1 size-3.5" /> Approve
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act("reject")}>
              <X className="mr-1 size-3.5" /> Reject
            </Button>
          </>
        )}
        {canEdit && isPending && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("withdraw")}>
            Withdraw
          </Button>
        )}
        {canEdit && doc.status === "approved" && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act("publish")}>
            Publish
          </Button>
        )}
        {canEdit && doc.status === "rejected" && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("revert")}>
            Return to draft
          </Button>
        )}
      </div>
    </div>
  )
}

function VersionsTab({
  doc,
  versions,
  access,
  onChanged,
}: {
  doc: DmsDocument
  versions: DmsDocumentFile[]
  access: AccessLevel | null
  onChanged: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const canEdit = canPerform("edit", access)
  const canDownload = canPerform("download", access)

  async function open(fileId: number, disposition: "inline" | "attachment") {
    try {
      const res = await fetch(
        `/api/dms/documents/${doc.id}/download?fileId=${fileId}&disposition=${disposition === "inline" ? "inline" : "attachment"}`,
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Could not open file")
      window.open(body.url, "_blank", "noopener,noreferrer")
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function upload() {
    if (!file) {
      toast.error("Choose a file first.")
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      fd.set("file", file)
      const res = await fetch(`/api/dms/documents/${doc.id}/versions`, { method: "POST", body: fd })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Upload failed")
      toast.success("New version uploaded")
      setFile(null)
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="flex items-end gap-2 rounded-lg border p-3">
          <div className="grid flex-1 gap-1.5">
            <Label>Upload new version</Label>
            <Input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </div>
          <Button onClick={upload} disabled={busy}>
            <Upload className="mr-1.5 size-4" /> {busy ? "Uploading…" : "Upload"}
          </Button>
        </div>
      )}

      {versions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No file versions yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-medium">Ver.</th>
                <th className="p-3 font-medium">File</th>
                <th className="p-3 font-medium">Size</th>
                <th className="p-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id} className="border-t align-middle">
                  <td className="p-3">
                    <span className="inline-flex items-center gap-1.5">
                      v{v.version}
                      {doc.fileId === v.id && (
                        <Badge variant="outline" className="border-primary/40 bg-primary/10 text-primary">
                          Current
                        </Badge>
                      )}
                    </span>
                  </td>
                  <td className="p-3">
                    <div className="max-w-[220px] truncate">{v.filename || v.fileRef}</div>
                    <div className="text-xs text-muted-foreground">{v.mimeType || "—"}</div>
                  </td>
                  <td className="whitespace-nowrap p-3 text-muted-foreground">{formatBytes(v.size)}</td>
                  <td className="whitespace-nowrap p-3 text-right">
                    {canDownload && (
                      <div className="inline-flex gap-1">
                        <Button size="icon" variant="ghost" onClick={() => open(v.id, "inline")} aria-label="Preview">
                          <Eye className="size-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => open(v.id, "attachment")} aria-label="Download">
                          <Download className="size-4" />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function PermissionsTab({
  docId,
  permissions,
  onChanged,
}: {
  docId: number
  permissions: DmsPermission[]
  onChanged: () => void
}) {
  const [subjectType, setSubjectType] = useState("user")
  const [subjectId, setSubjectId] = useState("")
  const [accessLevel, setAccessLevel] = useState("view")
  const [busy, setBusy] = useState(false)

  async function add() {
    if (!subjectId.trim()) {
      toast.error("Enter a user ID or role.")
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/dms/documents/${docId}/permissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectType, subjectId: subjectId.trim(), accessLevel }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Could not add permission")
      toast.success("Permission granted")
      setSubjectId("")
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(permId: number) {
    try {
      const res = await fetch(`/api/dms/documents/${docId}/permissions?permId=${permId}`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Could not remove permission")
      toast.success("Permission removed")
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border p-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="grid gap-1.5">
            <Label className="text-xs">Subject</Label>
            <Select value={subjectType} onValueChange={setSubjectType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User</SelectItem>
                <SelectItem value="role">Role</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">{subjectType === "user" ? "User ID" : "Role"}</Label>
            <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder={subjectType === "user" ? "e.g. 42" : "e.g. manager"} />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Access</Label>
            <Select value={accessLevel} onValueChange={setAccessLevel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="view">View</SelectItem>
                <SelectItem value="download">Download</SelectItem>
                <SelectItem value="edit">Edit</SelectItem>
                <SelectItem value="manage">Manage</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <Button onClick={add} disabled={busy} className="w-fit">
          Grant access
        </Button>
      </div>

      {permissions.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No explicit grants. Only owners and administrators can access this document.
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="p-3 font-medium">Subject</th>
                <th className="p-3 font-medium">Access</th>
                <th className="p-3 text-right font-medium" />
              </tr>
            </thead>
            <tbody>
              {permissions.map((p) => (
                <tr key={p.id} className="border-t align-middle">
                  <td className="p-3">
                    <span className="capitalize text-muted-foreground">{p.subjectType}</span> · {p.subjectId}
                  </td>
                  <td className="p-3 capitalize">{p.accessLevel}</td>
                  <td className="p-3 text-right">
                    <Button size="icon" variant="ghost" onClick={() => remove(p.id)} aria-label="Remove">
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function SharingTab({
  docId,
  shares,
  onChanged,
}: {
  docId: number
  shares: (DmsShare & { url?: string })[]
  onChanged: () => void
}) {
  const [access, setAccess] = useState("view")
  const [expiresAt, setExpiresAt] = useState("")
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    try {
      const res = await fetch(`/api/dms/documents/${docId}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access, expiresAt: expiresAt || null }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Could not create link")
      toast.success("Share link created")
      setExpiresAt("")
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function revoke(shareId: number) {
    try {
      const res = await fetch(`/api/dms/documents/${docId}/shares?shareId=${shareId}`, { method: "DELETE" })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Could not revoke link")
      toast.success("Link revoked")
      onChanged()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  function copy(url: string) {
    navigator.clipboard?.writeText(url).then(
      () => toast.success("Link copied"),
      () => toast.error("Could not copy"),
    )
  }

  const activeShares = shares.filter((s) => !s.revokedAt)

  return (
    <div className="space-y-4">
      <div className="grid gap-3 rounded-lg border p-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="grid gap-1.5">
            <Label className="text-xs">Access</Label>
            <Select value={access} onValueChange={setAccess}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="view">View only</SelectItem>
                <SelectItem value="download">Allow download</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Expires (optional)</Label>
            <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
        </div>
        <Button onClick={create} disabled={busy} className="w-fit">
          <Link2 className="mr-1.5 size-4" /> Create link
        </Button>
      </div>

      {activeShares.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">No active share links.</p>
      ) : (
        <div className="space-y-2">
          {activeShares.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border p-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {s.access}
                  </Badge>
                  {s.expiresAt && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3" /> expires {formatDate(s.expiresAt)}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">{s.downloadCount} opens</span>
                </div>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{s.url}</div>
              </div>
              <Button size="icon" variant="ghost" onClick={() => s.url && copy(s.url)} aria-label="Copy link">
                <Copy className="size-4" />
              </Button>
              <Button size="icon" variant="ghost" onClick={() => revoke(s.id)} aria-label="Revoke link">
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function AuditTab({ audit }: { audit: DmsAuditEntry[] }) {
  if (audit.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
  }
  return (
    <ol className="space-y-3">
      {audit.map((a) => (
        <li key={a.id} className="flex gap-3 text-sm">
          <div className="mt-1 size-2 shrink-0 rounded-full bg-primary/60" />
          <div className="min-w-0">
            <div className="font-medium capitalize">{a.action.replace(/_/g, " ")}</div>
            {a.detail && <div className="truncate text-xs text-muted-foreground">{a.detail}</div>}
            <div className="text-xs text-muted-foreground">
              {a.userId ? `User ${a.userId} · ` : ""}
              {formatDateTime(a.createdAt)}
            </div>
          </div>
        </li>
      ))}
    </ol>
  )
}

function formatBytes(bytes: number): string {
  if (!bytes) return "—"
  const units = ["B", "KB", "MB", "GB"]
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function formatDate(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString()
}

function formatDateTime(value: string | null): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString()
}
