"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Newspaper } from "lucide-react"
import type { Meta } from "@/components/notice-board/shared"
import { FeedView } from "@/components/notice-board/feed-view"
import { ManageView } from "@/components/notice-board/manage-view"
import { ComposeDialog } from "@/components/notice-board/compose-dialog"
import { DetailDialog } from "@/components/notice-board/detail-dialog"
import { AnalyticsDialog } from "@/components/notice-board/analytics-dialog"

export function NoticeBoardClient() {
  // Cheap probe: the self-feed always returns canManage, so we can branch the UI.
  const { data: probe } = useSWR<{ canManage: boolean }>("/api/notice-board?page=1&pageSize=1", fetcher)
  const canManage = !!probe?.canManage

  // Meta (dropdown sources) is only fetchable by managers.
  const { data: meta } = useSWR<Meta>(canManage ? "/api/notice-board/meta" : null, fetcher)

  const [composeOpen, setComposeOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [analyticsId, setAnalyticsId] = useState<number | null>(null)
  const [manageRefresh, setManageRefresh] = useState(0)

  function openCompose(id: number | null) {
    setEditingId(id)
    setComposeOpen(true)
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6">
      <header className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Newspaper className="size-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Notice Board</h1>
          <p className="text-sm text-muted-foreground">Company announcements, policies and updates.</p>
        </div>
      </header>

      {canManage ? (
        <Tabs defaultValue="feed">
          <TabsList>
            <TabsTrigger value="feed">My Notices</TabsTrigger>
            <TabsTrigger value="manage">Manage</TabsTrigger>
          </TabsList>
          <TabsContent value="feed" className="mt-4">
            <FeedView meta={meta} onView={setDetailId} />
          </TabsContent>
          <TabsContent value="manage" className="mt-4">
            <ManageView
              key={manageRefresh}
              meta={meta}
              onCompose={() => openCompose(null)}
              onEdit={(id) => openCompose(id)}
              onAnalytics={setAnalyticsId}
              onView={setDetailId}
            />
          </TabsContent>
        </Tabs>
      ) : (
        <FeedView meta={meta} onView={setDetailId} />
      )}

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        editingId={editingId}
        meta={meta}
        onSaved={() => setManageRefresh((n) => n + 1)}
      />
      <DetailDialog
        noticeId={detailId}
        open={detailId != null}
        onOpenChange={(o) => { if (!o) setDetailId(null) }}
        onChanged={() => setManageRefresh((n) => n + 1)}
      />
      <AnalyticsDialog
        noticeId={analyticsId}
        open={analyticsId != null}
        onOpenChange={(o) => { if (!o) setAnalyticsId(null) }}
      />
    </div>
  )
}
