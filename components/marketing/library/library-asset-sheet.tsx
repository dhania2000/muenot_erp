"use client"

import { useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Download,
  Upload,
  Archive,
  Trash2,
  RotateCcw,
  Loader2,
  FileText,
  ImageIcon,
  Film,
  Music,
  Link2,
  History,
  Activity,
} from "lucide-react"
import {
  ASSET_TYPES,
  ASSET_CATEGORIES,
  ASSET_STATUSES,
  humanBytes,
  jsonFetcher,
  statusVariant,
  type LibraryAsset,
  type LibraryFolder,
  type AssetVersion,
  type AssetUsage,
  type AssetAudit,
} from "./library-shared"

function KindIcon({ kind, className }: { kind: LibraryAsset["kind"]; className?: string }) {
  if (kind === "image") return <ImageIcon className={className} />
  if (kind === "video") return <Film className={className} />
  if (kind === "audio") return <Music className={className} />
  return <FileText className={className} />
}

export function LibraryAssetSheet({
  assetId,
  open,
  onOpenChange,
  folders,
  canManage,
  onChanged,
}: {
  assetId: number | null
  open: boolean
  onOpenChange: (v: boolean) => void
  folders: LibraryFolder[]
  canManage: boolean
  onChanged: () => void
}) {
  const { data, mutate, isLoading } = useSWR<{
    asset: LibraryAsset
    versions: AssetVersion[]
    usage: AssetUsage[]
    audit: AssetAudit[]
  }>(open && assetId ? `/api/marketing/library/${assetId}` : null, jsonFetcher)

  const asset = data?.asset
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<Partial<LibraryAsset>>({})
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleteBlock, setDeleteBlock] = useState<{ refCount: number } | null>(null)
  const versionInput = useRef<HTMLInputElement>(null)
  const [uploadingVersion, setUploadingVersion] = useState(false)

  function startEdit() {
    if (!asset) return
    setForm({
      name: asset.name,
      assetType: asset.assetType,
      category: asset.category,
      description: asset.description,
      ownerName: asset.ownerName,
      department: asset.department,
      expiryDate: asset.expiryDate,
      usageRights: asset.usageRights,
      copyright: asset.copyright,
      license: asset.license,
      attribution: asset.attribution,
      restrictions: asset.restrictions,
      folderId: asset.folderId,
      tags: asset.tags,
    })
    setEditing(true)
  }

  async function save() {
    if (!asset) return
    setSaving(true)
    const res = await fetch(`/api/marketing/library/${asset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (!res.ok) {
      toast.error("Failed to save changes")
      return
    }
    toast.success("Asset updated")
    setEditing(false)
    mutate()
    onChanged()
  }

  async function setStatus(status: string) {
    if (!asset) return
    const res = await fetch(`/api/marketing/library/${asset.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    })
    if (!res.ok) {
      toast.error("Failed to update status")
      return
    }
    toast.success(status === "Archived" ? "Asset archived" : `Status set to ${status}`)
    mutate()
    onChanged()
  }

  async function doDelete(force: boolean) {
    if (!asset) return
    const res = await fetch(`/api/marketing/library/${asset.id}${force ? "?force=1" : ""}`, { method: "DELETE" })
    if (res.status === 409) {
      const d = await res.json().catch(() => ({}))
      setDeleteBlock({ refCount: d.refCount || 0 })
      return
    }
    if (!res.ok) {
      toast.error("Failed to delete")
      return
    }
    toast.success("Asset deleted")
    setConfirmDelete(false)
    setDeleteBlock(null)
    onOpenChange(false)
    onChanged()
  }

  async function uploadVersion(file: File) {
    if (!asset) return
    setUploadingVersion(true)
    const fd = new FormData()
    fd.append("file", file)
    fd.append("change_note", `Uploaded ${file.name}`)
    const res = await fetch(`/api/marketing/library/${asset.id}/versions`, { method: "POST", body: fd })
    setUploadingVersion(false)
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      toast.error(d.error || "Version upload failed")
      return
    }
    toast.success("New version uploaded")
    mutate()
    onChanged()
  }

  async function restore(version: number) {
    if (!asset) return
    const res = await fetch(`/api/marketing/library/${asset.id}/versions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    })
    if (!res.ok) {
      toast.error("Restore failed")
      return
    }
    toast.success(`Restored version ${version}`)
    mutate()
    onChanged()
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
        {isLoading || !asset ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <SheetHeader className="border-b p-4 text-left">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <SheetTitle className="truncate">{asset.name}</SheetTitle>
                  <SheetDescription className="flex flex-wrap items-center gap-2 pt-1">
                    <span className="font-mono text-xs">{asset.assetId}</span>
                    <Badge variant={statusVariant(asset.status)}>{asset.status}</Badge>
                    <Badge variant="outline">v{asset.version}</Badge>
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="flex items-center justify-center border-b bg-muted/40 p-4">
              {asset.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={asset.previewUrl || "/placeholder.svg"}
                  alt={asset.name}
                  className="max-h-48 rounded-md object-contain"
                  crossOrigin="anonymous"
                />
              ) : (
                <div className="flex h-32 w-full flex-col items-center justify-center gap-2 text-muted-foreground">
                  <KindIcon kind={asset.kind} className="size-10" />
                  <span className="text-xs uppercase">{asset.fileType || asset.kind}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2 border-b p-3">
              <Button size="sm" asChild>
                <a href={asset.downloadUrl}>
                  <Download className="size-4" /> Download
                </a>
              </Button>
              {canManage && (
                <>
                  <Button size="sm" variant="outline" onClick={() => versionInput.current?.click()} disabled={uploadingVersion}>
                    {uploadingVersion ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} New Version
                  </Button>
                  <input
                    ref={versionInput}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.[0]) uploadVersion(e.target.files[0])
                      e.target.value = ""
                    }}
                  />
                  {asset.status !== "Archived" ? (
                    <Button size="sm" variant="outline" onClick={() => setStatus("Archived")}>
                      <Archive className="size-4" /> Archive
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setStatus("Active")}>
                      <RotateCcw className="size-4" /> Unarchive
                    </Button>
                  )}
                  <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                    <Trash2 className="size-4" /> Delete
                  </Button>
                </>
              )}
            </div>

            <Tabs defaultValue="details" className="flex-1">
              <TabsList className="m-3 grid w-[calc(100%-1.5rem)] grid-cols-4">
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="versions" className="gap-1">
                  <History className="size-3.5" /> {data?.versions.length || 0}
                </TabsTrigger>
                <TabsTrigger value="usage" className="gap-1">
                  <Link2 className="size-3.5" /> {data?.usage.length || 0}
                </TabsTrigger>
                <TabsTrigger value="audit" className="gap-1">
                  <Activity className="size-3.5" />
                </TabsTrigger>
              </TabsList>

              <TabsContent value="details" className="px-4 pb-6">
                {editing ? (
                  <div className="flex flex-col gap-3">
                    <Field label="Name">
                      <Input value={form.name || ""} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Asset Type">
                        <Select value={form.assetType || ""} onValueChange={(v) => setForm((f) => ({ ...f, assetType: v }))}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {ASSET_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Category">
                        <Select value={form.category || ""} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
                          <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                          <SelectContent>
                            {ASSET_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    <Field label="Folder">
                      <Select
                        value={form.folderId != null ? String(form.folderId) : "none"}
                        onValueChange={(v) => setForm((f) => ({ ...f, folderId: v === "none" ? null : Number(v) }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No folder</SelectItem>
                          {folders.map((fo) => <SelectItem key={fo.id} value={String(fo.id)}>{fo.path}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Description">
                      <Textarea
                        rows={2}
                        value={form.description || ""}
                        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                      />
                    </Field>
                    <Field label="Tags (comma separated)">
                      <Input
                        value={(form.tags || []).join(", ")}
                        onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) }))}
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Owner">
                        <Input value={form.ownerName || ""} onChange={(e) => setForm((f) => ({ ...f, ownerName: e.target.value }))} />
                      </Field>
                      <Field label="Department">
                        <Input value={form.department || ""} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
                      </Field>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Expiry Date">
                        <Input type="date" value={(form.expiryDate || "").slice(0, 10)} onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))} />
                      </Field>
                      <Field label="License">
                        <Input value={form.license || ""} onChange={(e) => setForm((f) => ({ ...f, license: e.target.value }))} />
                      </Field>
                    </div>
                    <Field label="Usage Rights">
                      <Textarea rows={2} value={form.usageRights || ""} onChange={(e) => setForm((f) => ({ ...f, usageRights: e.target.value }))} />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Copyright">
                        <Input value={form.copyright || ""} onChange={(e) => setForm((f) => ({ ...f, copyright: e.target.value }))} />
                      </Field>
                      <Field label="Attribution">
                        <Input value={form.attribution || ""} onChange={(e) => setForm((f) => ({ ...f, attribution: e.target.value }))} />
                      </Field>
                    </div>
                    <Field label="Restrictions">
                      <Textarea rows={2} value={form.restrictions || ""} onChange={(e) => setForm((f) => ({ ...f, restrictions: e.target.value }))} />
                    </Field>
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" onClick={save} disabled={saving}>
                        {saving && <Loader2 className="size-4 animate-spin" />} Save
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 text-sm">
                    {asset.description && <p className="text-muted-foreground">{asset.description}</p>}
                    {asset.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {asset.tags.map((t) => (
                          <Badge key={t} variant="secondary" className="font-normal">{t}</Badge>
                        ))}
                      </div>
                    )}
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                      <Meta label="Type" value={asset.assetType} />
                      <Meta label="Category" value={asset.category} />
                      <Meta label="Folder" value={asset.folderPath} />
                      <Meta label="File" value={asset.fileName} />
                      <Meta label="Size" value={asset.fileSizeLabel} />
                      <Meta label="Format" value={asset.fileType} />
                      {asset.width ? <Meta label="Dimensions" value={`${asset.width} × ${asset.height}`} /> : null}
                      <Meta label="Owner" value={asset.ownerName} />
                      <Meta label="Department" value={asset.department} />
                      <Meta label="Usage" value={`${asset.usageCount} reference${asset.usageCount === 1 ? "" : "s"}`} />
                      <Meta label="Expiry" value={asset.expiryDate ? asset.expiryDate.slice(0, 10) : "—"} />
                      <Meta label="License" value={asset.license} />
                      <Meta label="Copyright" value={asset.copyright} />
                      <Meta label="Attribution" value={asset.attribution} />
                      <Meta label="Created" value={`${asset.createdByName || ""} ${asset.createdAt ? "· " + new Date(asset.createdAt).toLocaleDateString() : ""}`} />
                    </dl>
                    {asset.usageRights && <Meta label="Usage Rights" value={asset.usageRights} block />}
                    {asset.restrictions && <Meta label="Restrictions" value={asset.restrictions} block />}
                    {canManage && (
                      <Button size="sm" variant="outline" className="mt-2 w-fit" onClick={startEdit}>
                        Edit metadata
                      </Button>
                    )}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="versions" className="px-4 pb-6">
                <div className="flex flex-col gap-2">
                  {(data?.versions || []).map((v) => (
                    <div key={v.id} className="flex items-center gap-3 rounded-md border p-2.5 text-sm">
                      <Badge variant={v.version === asset.version ? "default" : "outline"}>v{v.version}</Badge>
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{v.change_note || v.file_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {humanBytes(v.file_size)} · {v.uploaded_by_name || "Unknown"} ·{" "}
                          {new Date(v.uploaded_at).toLocaleDateString()}
                        </p>
                      </div>
                      <Button size="icon" variant="ghost" asChild title="Download this version">
                        <a href={`${asset.downloadUrl}?version=${v.version}`}>
                          <Download className="size-4" />
                        </a>
                      </Button>
                      {canManage && v.version !== asset.version && (
                        <Button size="icon" variant="ghost" title="Restore this version" onClick={() => restore(v.version)}>
                          <RotateCcw className="size-4" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </TabsContent>

              <TabsContent value="usage" className="px-4 pb-6">
                {data?.usage.length ? (
                  <div className="flex flex-col gap-2">
                    {data.usage.map((u) => (
                      <div key={u.id} className="flex items-center gap-3 rounded-md border p-2.5 text-sm">
                        <Badge variant="outline" className="capitalize">{u.module}</Badge>
                        <span className="min-w-0 flex-1 truncate">{u.ref_label || u.ref_id}</span>
                        <span className="text-xs text-muted-foreground">{new Date(u.created_at).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Not referenced by any module yet.
                  </p>
                )}
              </TabsContent>

              <TabsContent value="audit" className="px-4 pb-6">
                <div className="flex flex-col gap-2">
                  {(data?.audit || []).map((a, i) => (
                    <div key={i} className="flex items-start gap-3 border-b pb-2 text-sm last:border-0">
                      <Badge variant="outline" className="capitalize">{a.action.replace(/_/g, " ")}</Badge>
                      <div className="min-w-0 flex-1">
                        {a.detail && <p className="truncate">{a.detail}</p>}
                        <p className="text-xs text-muted-foreground">
                          {a.user_name || "System"} · {new Date(a.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>

      <AlertDialog open={confirmDelete} onOpenChange={(v) => { setConfirmDelete(v); if (!v) setDeleteBlock(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this asset?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteBlock
                ? `This asset is referenced by ${deleteBlock.refCount} record(s). Deleting will break those references. Consider archiving instead. Confirm forced delete?`
                : "This permanently removes the asset and all its versions. This cannot be undone. Archiving is usually safer."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                doDelete(Boolean(deleteBlock))
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBlock ? "Force delete" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function Meta({ label, value, block }: { label: string; value: string | null | undefined; block?: boolean }) {
  if (!value) return null
  return (
    <div className={block ? "col-span-2" : ""}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  )
}
