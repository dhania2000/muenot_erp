"use client"

import { useEffect, useRef, useState } from "react"
import { Eraser, PenLine, Type, Upload } from "lucide-react"

type Mode = "draw" | "type" | "upload"

export type CapturedSignature = {
  dataUrl: string
  width: number
  height: number
}

const typeFonts = [
  { label: "Signature", css: '"Brush Script MT", "Segoe Script", cursive' },
  { label: "Formal", css: 'Georgia, "Times New Roman", serif' },
  { label: "Print", css: '"Trebuchet MS", system-ui, sans-serif' },
]

export function SignaturePad({
  onSave,
  onCancel,
}: {
  onSave: (sig: CapturedSignature) => void
  onCancel: () => void
}) {
  const [mode, setMode] = useState<Mode>("draw")
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const hasStroke = useRef(false)
  const [typed, setTyped] = useState("")
  const [fontIndex, setFontIndex] = useState(0)
  const [uploaded, setUploaded] = useState<string | null>(null)

  useEffect(() => {
    if (mode !== "draw") return
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * ratio
    canvas.height = rect.height * ratio
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 2.5
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = "#0f172a"
    hasStroke.current = false
  }, [mode])

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    const ctx = canvasRef.current?.getContext("2d")
    if (!ctx) return
    drawing.current = true
    hasStroke.current = true
    const { x, y } = pos(e)
    ctx.beginPath()
    ctx.moveTo(x, y)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext("2d")
    if (!ctx) return
    const { x, y } = pos(e)
    ctx.lineTo(x, y)
    ctx.stroke()
  }

  function end() {
    drawing.current = false
  }

  function clearCanvas() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    hasStroke.current = false
  }

  function renderTypedToCanvas(): CapturedSignature | null {
    const text = typed.trim()
    if (!text) return null
    const width = 640
    const height = 200
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.fillStyle = "#0f172a"
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    let fontSize = 84
    ctx.font = `${fontSize}px ${typeFonts[fontIndex].css}`
    while (ctx.measureText(text).width > width - 40 && fontSize > 20) {
      fontSize -= 4
      ctx.font = `${fontSize}px ${typeFonts[fontIndex].css}`
    }
    ctx.fillText(text, width / 2, height / 2)
    return { dataUrl: canvas.toDataURL("image/png"), width, height }
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setUploaded(reader.result as string)
    reader.readAsDataURL(file)
  }

  function save() {
    if (mode === "draw") {
      const canvas = canvasRef.current
      if (!canvas || !hasStroke.current) return
      onSave({ dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height })
      return
    }
    if (mode === "type") {
      const sig = renderTypedToCanvas()
      if (sig) onSave(sig)
      return
    }
    if (mode === "upload" && uploaded) {
      const img = new Image()
      img.crossOrigin = "anonymous"
      img.onload = () => onSave({ dataUrl: uploaded, width: img.naturalWidth, height: img.naturalHeight })
      img.src = uploaded
    }
  }

  const tabs: { id: Mode; label: string; icon: typeof PenLine }[] = [
    { id: "draw", label: "Draw", icon: PenLine },
    { id: "type", label: "Type", icon: Type },
    { id: "upload", label: "Upload", icon: Upload },
  ]

  const canSave =
    (mode === "draw" && hasStroke.current) || (mode === "type" && typed.trim().length > 0) || (mode === "upload" && !!uploaded)

  return (
    <div className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-lg">
      <h3 className="text-base font-semibold">Create your signature</h3>
      <p className="mt-1 text-sm text-muted-foreground">Draw, type, or upload an image of your signature.</p>

      <div className="mt-4 inline-flex rounded-lg border border-border p-1">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = mode === t.id
          return (
            <button
              key={t.id}
              onClick={() => setMode(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="size-4" />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="mt-4">
        {mode === "draw" && (
          <div>
            <div className="relative rounded-lg border border-dashed border-border bg-background">
              <canvas
                ref={canvasRef}
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={end}
                onPointerLeave={end}
                className="h-44 w-full touch-none"
              />
              <span className="pointer-events-none absolute inset-x-0 bottom-3 mx-auto w-4/5 border-b border-border/70" />
            </div>
            <button
              onClick={clearCanvas}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <Eraser className="size-3.5" />
              Clear
            </button>
          </div>
        )}

        {mode === "type" && (
          <div className="space-y-3">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Type your full name"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex flex-wrap gap-2">
              {typeFonts.map((f, i) => (
                <button
                  key={f.label}
                  onClick={() => setFontIndex(i)}
                  className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    fontIndex === i ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-muted"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <div className="flex h-28 items-center justify-center rounded-lg border border-dashed border-border bg-background">
              <span
                className="truncate px-4 text-4xl text-foreground"
                style={{ fontFamily: typeFonts[fontIndex].css }}
              >
                {typed.trim() || "Preview"}
              </span>
            </div>
          </div>
        )}

        {mode === "upload" && (
          <div>
            <label className="flex h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background text-sm text-muted-foreground hover:bg-muted/40">
              {uploaded ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={uploaded || "/placeholder.svg"} alt="Signature preview" className="max-h-36 object-contain" />
              ) : (
                <>
                  <Upload className="size-6" />
                  <span>Click to upload a signature image (PNG/JPG)</span>
                </>
              )}
              <input type="file" accept="image/png,image/jpeg" onChange={handleUpload} className="sr-only" />
            </label>
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-end gap-2">
        <button onClick={onCancel} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted">
          Cancel
        </button>
        <button
          onClick={save}
          disabled={!canSave}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Apply signature
        </button>
      </div>
    </div>
  )
}
