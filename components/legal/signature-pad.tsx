"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Eraser, PenLine, Upload } from "lucide-react"
import { SIGNATURE_IMAGE_TYPES, SIGNATURE_MAX_BYTES } from "@/lib/legal-esign-shared"

type Mode = "draw" | "upload"

/**
 * Reusable capture surface used by both the public signing page and the
 * authorized-signatory settings. Emits a PNG/JPEG data URL through onChange,
 * or null when cleared. Draw uses a high-DPI canvas; upload validates type/size.
 */
export function SignaturePad({
  onChange,
  allowDraw = true,
  allowUpload = true,
  height = 180,
}: {
  onChange: (dataUrl: string | null) => void
  allowDraw?: boolean
  allowUpload?: boolean
  height?: number
}) {
  const [mode, setMode] = useState<Mode>(allowDraw ? "draw" : "upload")
  const [uploadPreview, setUploadPreview] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState("")
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const hasInk = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * ratio
    canvas.height = rect.height * ratio
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 2.2
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = "#0f172a"
  }, [])

  useEffect(() => {
    if (mode !== "draw") return
    setupCanvas()
    const onResize = () => setupCanvas()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [mode, setupCanvas])

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function startDraw(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    last.current = pointFromEvent(e)
  }

  function moveDraw(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return
    const ctx = canvasRef.current?.getContext("2d")
    if (!ctx || !last.current) return
    const p = pointFromEvent(e)
    ctx.beginPath()
    ctx.moveTo(last.current.x, last.current.y)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    last.current = p
    hasInk.current = true
  }

  function endDraw() {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    if (hasInk.current) onChange(canvasRef.current?.toDataURL("image/png") ?? null)
  }

  function clearDraw() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext("2d")
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    hasInk.current = false
    onChange(null)
  }

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    setUploadError("")
    const file = e.target.files?.[0]
    if (!file) return
    if (!SIGNATURE_IMAGE_TYPES.includes(file.type)) {
      setUploadError("Only PNG or JPEG images are allowed.")
      return
    }
    if (file.size > SIGNATURE_MAX_BYTES) {
      setUploadError("Image is too large (max 3 MB).")
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      setUploadPreview(url)
      onChange(url)
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className="flex flex-col gap-3">
      {allowDraw && allowUpload && (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "draw" ? "default" : "outline"}
            onClick={() => {
              setMode("draw")
              onChange(null)
            }}
          >
            <PenLine data-icon="inline-start" /> Draw
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "upload" ? "default" : "outline"}
            onClick={() => {
              setMode("upload")
              onChange(null)
              setUploadPreview(null)
            }}
          >
            <Upload data-icon="inline-start" /> Upload
          </Button>
        </div>
      )}

      {mode === "draw" && allowDraw && (
        <div className="flex flex-col gap-2">
          <div className="relative rounded-lg border-2 border-dashed bg-white" style={{ height }}>
            <canvas
              ref={canvasRef}
              className="h-full w-full touch-none rounded-lg"
              style={{ height }}
              onPointerDown={startDraw}
              onPointerMove={moveDraw}
              onPointerUp={endDraw}
              onPointerLeave={endDraw}
            />
            <span className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs text-muted-foreground">
              Sign above using your mouse or finger
            </span>
          </div>
          <div>
            <Button type="button" size="sm" variant="ghost" onClick={clearDraw}>
              <Eraser data-icon="inline-start" /> Clear
            </Button>
          </div>
        </div>
      )}

      {mode === "upload" && allowUpload && (
        <div className="flex flex-col gap-2">
          {uploadPreview ? (
            <div className="flex items-center justify-between rounded-lg border bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={uploadPreview || "/placeholder.svg"} alt="Signature preview" className="max-h-24" />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setUploadPreview(null)
                  onChange(null)
                }}
              >
                Remove
              </Button>
            </div>
          ) : (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed bg-muted/30 p-6 text-center text-sm text-muted-foreground hover:bg-muted/50">
              <Upload className="size-5" />
              <span>Click to upload a signature image (PNG or JPEG, max 3 MB)</span>
              <input type="file" accept={SIGNATURE_IMAGE_TYPES.join(",")} className="sr-only" onChange={handleUpload} />
            </label>
          )}
          {uploadError && <p className="text-xs text-rose-600">{uploadError}</p>}
        </div>
      )}
    </div>
  )
}
