"use client"

import useSWR from "swr"
import { HardDriveUpload } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { LargeFileUpload } from "@/components/storage/large-file-upload"

type SessionRow = {
  id: number
  filename: string
  size: number
  category: string
  status: string
  uploadedParts: number[]
  totalParts: number
}

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : { sessions: [] }))

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/**
 * Storage-module panel that hosts the resumable large uploader and
 * lists any in-progress sessions that can still be resumed.
 */
export function LargeUploadsPanel() {
  const { data, mutate } = useSWR<{ sessions: SessionRow[] }>("/api/storage/uploads", fetcher, {
    revalidateOnFocus: false,
  })
  const pending = (data?.sessions ?? []).filter((s) => s.status === "pending")

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <HardDriveUpload className="size-5 text-muted-foreground" aria-hidden="true" />
          <CardTitle>Large file uploads</CardTitle>
        </div>
        <CardDescription>
          Upload large videos, images, documents, ZIPs, and training or employee files. Transfers are chunked and
          resume automatically if a connection drops.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <LargeFileUpload onUploaded={() => mutate()} />

        {pending.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Incomplete uploads</h3>
            <ul className="flex flex-col gap-2">
              {pending.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between rounded-md border p-3 text-sm"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{s.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatBytes(s.size)} · {s.uploadedParts.length}/{s.totalParts} chunks received
                    </span>
                  </div>
                  <Badge variant="secondary">Resumable</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
