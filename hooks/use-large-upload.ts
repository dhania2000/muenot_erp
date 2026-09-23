"use client"

import { useCallback, useRef, useState } from "react"

/**
 * Client-side driver for resumable, chunked large-file uploads.
 * ---------------------------------------------------------------------------
 * Orchestrates the multipart API:
 *   1. POST /api/storage/uploads            → open a session (get part size).
 *   2. PUT  /api/storage/uploads/:id/parts/:n → send each chunk, with retries.
 *   3. POST /api/storage/uploads/:id/complete → finalize.
 *   4. DELETE /api/storage/uploads/:id        → cancel.
 *
 * Features: progress tracking, per-chunk retry with backoff, cancellation via
 * AbortController, and resume (skips part numbers the server already has).
 */

export type UploadStatus = "idle" | "starting" | "uploading" | "completing" | "done" | "error" | "canceled"

export type UploadCategory = "video" | "image" | "document" | "zip" | "training" | "employee" | "other"

export type LargeUploadState = {
  status: UploadStatus
  /** 0–100 across all chunks. */
  progress: number
  uploadedBytes: number
  totalBytes: number
  sessionId: number | null
  storageKey: string | null
  error: string | null
  /** Current chunk retry attempt, surfaced so the UI can show "retrying…". */
  retrying: boolean
}

const INITIAL: LargeUploadState = {
  status: "idle",
  progress: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  sessionId: null,
  storageKey: null,
  error: null,
  retrying: false,
}

const MAX_CHUNK_RETRIES = 4

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export function useLargeUpload() {
  const [state, setState] = useState<LargeUploadState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)
  const canceledRef = useRef(false)

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    canceledRef.current = false
    setState(INITIAL)
  }, [])

  const cancel = useCallback(async () => {
    canceledRef.current = true
    abortRef.current?.abort()
    const sessionId = state.sessionId
    setState((s) => ({ ...s, status: "canceled" }))
    if (sessionId != null) {
      // Best-effort: tell the server to abort the provider multipart upload.
      await fetch(`/api/storage/uploads/${sessionId}`, { method: "DELETE" }).catch(() => {})
    }
  }, [state.sessionId])

  /**
   * Upload one file end-to-end. Resolves with the stored key on success, or
   * null on failure/cancellation (state.error carries the reason).
   */
  const upload = useCallback(
    async (
      file: File,
      opts: { category?: UploadCategory; path?: string } = {},
    ): Promise<{ key: string } | null> => {
      canceledRef.current = false
      abortRef.current = new AbortController()
      const signal = abortRef.current.signal

      setState({ ...INITIAL, status: "starting", totalBytes: file.size })

      // 1. Open a session.
      let sessionId: number
      let partSize: number
      let totalParts: number
      let alreadyUploaded = new Set<number>()
      try {
        const res = await fetch("/api/storage/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            size: file.size,
            contentType: file.type || "application/octet-stream",
            category: opts.category ?? "other",
            path: opts.path,
          }),
          signal,
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error || "Could not start upload")
        sessionId = data.session.id
        partSize = data.partSize
        totalParts = data.totalParts
        alreadyUploaded = new Set<number>(data.session.uploadedParts ?? [])
      } catch (err: any) {
        if (signal.aborted || canceledRef.current) {
          setState((s) => ({ ...s, status: "canceled" }))
          return null
        }
        setState((s) => ({ ...s, status: "error", error: err?.message || "Could not start upload" }))
        return null
      }

      setState((s) => ({ ...s, status: "uploading", sessionId }))

      // 2. Send each missing chunk, with per-chunk retry.
      let uploadedBytes = 0
      for (let part = 1; part <= totalParts; part++) {
        const start = (part - 1) * partSize
        const end = Math.min(start + partSize, file.size)
        const chunkSize = end - start

        // Resume: skip chunks the server already holds.
        if (alreadyUploaded.has(part)) {
          uploadedBytes += chunkSize
          setState((s) => ({
            ...s,
            uploadedBytes,
            progress: Math.round((uploadedBytes / file.size) * 100),
          }))
          continue
        }

        const blob = file.slice(start, end)
        let sent = false
        for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
          if (canceledRef.current || signal.aborted) {
            setState((s) => ({ ...s, status: "canceled" }))
            return null
          }
          try {
            const res = await fetch(`/api/storage/uploads/${sessionId}/parts/${part}`, {
              method: "PUT",
              body: blob,
              signal,
            })
            if (!res.ok) {
              const data = await res.json().catch(() => ({}))
              throw new Error(data?.error || `Chunk ${part} failed`)
            }
            sent = true
            setState((s) => ({ ...s, retrying: false }))
            break
          } catch (err: any) {
            if (canceledRef.current || signal.aborted) {
              setState((s) => ({ ...s, status: "canceled" }))
              return null
            }
            if (attempt === MAX_CHUNK_RETRIES) {
              setState((s) => ({
                ...s,
                status: "error",
                retrying: false,
                error: err?.message || `Chunk ${part} failed after retries`,
              }))
              return null
            }
            // Exponential backoff before retrying the failed chunk.
            setState((s) => ({ ...s, retrying: true }))
            await sleep(500 * 2 ** attempt)
          }
        }
        if (!sent) return null

        uploadedBytes += chunkSize
        setState((s) => ({
          ...s,
          uploadedBytes,
          progress: Math.round((uploadedBytes / file.size) * 100),
        }))
      }

      // 3. Finalize.
      setState((s) => ({ ...s, status: "completing" }))
      try {
        const res = await fetch(`/api/storage/uploads/${sessionId}/complete`, {
          method: "POST",
          signal,
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data?.error || "Could not finalize upload")
        setState((s) => ({
          ...s,
          status: "done",
          progress: 100,
          uploadedBytes: file.size,
          storageKey: data.key,
        }))
        return { key: data.key as string }
      } catch (err: any) {
        if (canceledRef.current || signal.aborted) {
          setState((s) => ({ ...s, status: "canceled" }))
          return null
        }
        setState((s) => ({ ...s, status: "error", error: err?.message || "Could not finalize upload" }))
        return null
      }
    },
    [],
  )

  return { state, upload, cancel, reset }
}
