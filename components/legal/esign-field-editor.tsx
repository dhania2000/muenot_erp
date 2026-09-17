"use client"

import { useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Plus, Minus, Trash2, Loader2, MousePointerClick } from "lucide-react"
import {
  FIELD_TYPE_META,
  FIELD_TYPES,
  type EsignRequest,
  type FieldType,
  type EsignField,
} from "@/lib/legal-esign-shared"

type Placed = {
  id: string
  signerId: number
  fieldType: FieldType
  page: number
  x: number
  y: number
  width: number
  height: number
}

// A palette so each signer's fields are visually distinct.
const SIGNER_COLORS = [
  { border: "border-sky-500", bg: "bg-sky-500/15", text: "text-sky-700", dot: "bg-sky-500" },
  { border: "border-violet-500", bg: "bg-violet-500/15", text: "text-violet-700", dot: "bg-violet-500" },
  { border: "border-emerald-500", bg: "bg-emerald-500/15", text: "text-emerald-700", dot: "bg-emerald-500" },
  { border: "border-amber-500", bg: "bg-amber-500/15", text: "text-amber-700", dot: "bg-amber-500" },
  { border: "border-rose-500", bg: "bg-rose-500/15", text: "text-rose-700", dot: "bg-rose-500" },
]

const DEFAULT_SIZE: Record<FieldType, { w: number; h: number }> = {
  signature: { w: 0.24, h: 0.07 },
  date: { w: 0.16, h: 0.04 },
  name: { w: 0.24, h: 0.04 },
  designation: { w: 0.24, h: 0.04 },
  text: { w: 0.24, h: 0.04 },
}

const A4_RATIO = 1.4142 // height / width

export function EsignFieldEditor({
  request,
  onClose,
  onSaved,
}: {
  request: EsignRequest
  onClose: () => void
  onSaved: (updated: EsignRequest) => void
}) {
  const signers = request.signers || []
  const [activeSigner, setActiveSigner] = useState<number>(signers[0]?.id ?? 0)
  const [activeType, setActiveType] = useState<FieldType>("signature")
  const [pageCount, setPageCount] = useState(1)
  const [placed, setPlaced] = useState<Placed[]>(() =>
    (signers.flatMap((s) => (s.fields || []).map((f) => toPlaced(f))) as Placed[]) ?? [],
  )
  const [saving, setSaving] = useState(false)
  const dragRef = useRef<{ id: string; startX: number; startY: number; ox: number; oy: number } | null>(null)

  const initialPages = useMemo(() => {
    const max = placed.reduce((m, p) => Math.max(m, p.page), 1)
    return max
  }, [])
  useState(() => setPageCount(initialPages))

  const signerColor = (signerId: number) => {
    const idx = signers.findIndex((s) => s.id === signerId)
    return SIGNER_COLORS[Math.max(0, idx) % SIGNER_COLORS.length]
  }

  function addFieldAt(page: number, xFrac: number, yFrac: number) {
    if (!activeSigner) {
      toast.error("Add a signer first")
      return
    }
    const size = DEFAULT_SIZE[activeType]
    setPlaced((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        signerId: activeSigner,
        fieldType: activeType,
        page,
        x: clamp(xFrac - size.w / 2, 0, 1 - size.w),
        y: clamp(yFrac - size.h / 2, 0, 1 - size.h),
        width: size.w,
        height: size.h,
      },
    ])
  }

  function onPageClick(e: React.MouseEvent<HTMLDivElement>, page: number) {
    if (dragRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    addFieldAt(page, (e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height)
  }

  function startDrag(e: React.PointerEvent, f: Placed) {
    e.stopPropagation()
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-page]") as HTMLElement | null
    if (!pageEl) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { id: f.id, startX: e.clientX, startY: e.clientY, ox: f.x, oy: f.y }
  }

  function onDrag(e: React.PointerEvent, f: Placed) {
    const d = dragRef.current
    if (!d || d.id !== f.id) return
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-page]") as HTMLElement | null
    if (!pageEl) return
    const rect = pageEl.getBoundingClientRect()
    const dx = (e.clientX - d.startX) / rect.width
    const dy = (e.clientY - d.startY) / rect.height
    setPlaced((prev) =>
      prev.map((p) =>
        p.id === f.id
          ? { ...p, x: clamp(d.ox + dx, 0, 1 - p.width), y: clamp(d.oy + dy, 0, 1 - p.height) }
          : p,
      ),
    )
  }

  function endDrag(e: React.PointerEvent) {
    if (dragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {}
    }
    // Defer clearing so the page click handler sees the drag and ignores it.
    setTimeout(() => (dragRef.current = null), 0)
  }

  function removeField(id: string) {
    setPlaced((prev) => prev.filter((p) => p.id !== id))
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch(`/api/legal/esign/${request.id}/fields`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: placed.map((p) => ({
            signerId: p.signerId,
            fieldType: p.fieldType,
            page: p.page,
            x: p.x,
            y: p.y,
            width: p.width,
            height: p.height,
          })),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success("Field layout saved")
        onSaved(d.request as EsignRequest)
      } else {
        toast.error(d.error || "Could not save fields")
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[94vh] w-[calc(100vw-1rem)] flex-col overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b p-4">
          <DialogTitle>Place signature fields</DialogTitle>
          <DialogDescription>
            Pick a signer and field type, then click on the document to drop a field. Drag any field to reposition it.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-0 lg:flex-row">
          {/* Controls */}
          <aside className="flex shrink-0 flex-col gap-4 border-b p-4 lg:w-64 lg:border-b-0 lg:border-r">
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Signer</span>
              <div className="flex flex-col gap-1.5">
                {signers.map((s) => {
                  const c = signerColor(s.id)
                  const count = placed.filter((p) => p.signerId === s.id).length
                  return (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setActiveSigner(s.id)}
                      className={`flex items-center gap-2 rounded-lg border p-2 text-left text-sm transition-colors ${
                        activeSigner === s.id ? `${c.border} ${c.bg}` : "hover:border-primary/40"
                      }`}
                    >
                      <span className={`size-2.5 shrink-0 rounded-full ${c.dot}`} />
                      <span className="min-w-0 flex-1 truncate">{s.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{count}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Field type</span>
              <Select value={activeType} onValueChange={(v) => setActiveType(v as FieldType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {FIELD_TYPE_META[t].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Pages</span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => setPageCount((n) => Math.max(1, n - 1))}
                  disabled={pageCount <= 1 || placed.some((p) => p.page === pageCount)}
                >
                  <Minus className="size-4" />
                </Button>
                <span className="w-8 text-center text-sm tabular-nums">{pageCount}</span>
                <Button type="button" size="icon" variant="outline" onClick={() => setPageCount((n) => n + 1)}>
                  <Plus className="size-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Match the document&apos;s page count. Use the preview to line fields up.
              </p>
            </div>

            <div className="mt-auto rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <MousePointerClick className="size-3.5" /> {placed.length} field{placed.length === 1 ? "" : "s"} placed
              </div>
              <p className="mt-1">The document preview on the right is your reference. Fields map by relative position.</p>
            </div>
          </aside>

          {/* Canvas */}
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto bg-muted/30 p-4 xl:grid-cols-2">
            {/* Placement pages */}
            <div className="flex flex-col gap-4">
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => (
                <div key={page} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Page {page}</span>
                  <div
                    data-page={page}
                    onClick={(e) => onPageClick(e, page)}
                    className="relative w-full cursor-crosshair rounded-md border bg-white shadow-sm"
                    style={{ aspectRatio: `1 / ${A4_RATIO}` }}
                  >
                    {placed
                      .filter((p) => p.page === page)
                      .map((f) => {
                        const c = signerColor(f.signerId)
                        return (
                          <div
                            key={f.id}
                            onPointerDown={(e) => startDrag(e, f)}
                            onPointerMove={(e) => onDrag(e, f)}
                            onPointerUp={endDrag}
                            className={`group absolute flex cursor-move items-center justify-center rounded border-2 ${c.border} ${c.bg} ${c.text} touch-none`}
                            style={{
                              left: `${f.x * 100}%`,
                              top: `${f.y * 100}%`,
                              width: `${f.width * 100}%`,
                              height: `${f.height * 100}%`,
                            }}
                          >
                            <span className="pointer-events-none select-none truncate px-1 text-[10px] font-medium">
                              {FIELD_TYPE_META[f.fieldType].label}
                            </span>
                            <button
                              type="button"
                              onPointerDown={(e) => e.stopPropagation()}
                              onClick={(e) => {
                                e.stopPropagation()
                                removeField(f.id)
                              }}
                              className="absolute -right-2 -top-2 hidden size-4 items-center justify-center rounded-full bg-rose-600 text-white group-hover:flex"
                              aria-label="Remove field"
                            >
                              <Trash2 className="size-2.5" />
                            </button>
                          </div>
                        )
                      })}
                  </div>
                </div>
              ))}
            </div>

            {/* Live document reference */}
            <div className="hidden flex-col gap-1 xl:flex">
              <span className="text-xs text-muted-foreground">Document preview</span>
              <iframe
                title="Document preview"
                src={`/api/legal/esign/${request.id}/pdf#view=FitH`}
                className="h-full min-h-[480px] w-full rounded-md border bg-white"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="border-t p-4">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Save fields
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function toPlaced(f: EsignField): Placed {
  return {
    id: `db-${f.id}`,
    signerId: f.signer_id,
    fieldType: f.field_type,
    page: f.page || 1,
    x: f.pos_x,
    y: f.pos_y,
    width: f.width,
    height: f.height,
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}
