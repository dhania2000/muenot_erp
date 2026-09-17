"use client"

import { useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  type ArticleDetail as Detail, StatusBadge, TypeBadge, AUDIENCE_LABELS,
  formatDate, formatDateTime, formatBytes,
} from "./kb-lib"
import {
  X, Star, ThumbsUp, ThumbsDown, Check, CheckCheck, Paperclip, Download, Pencil, Copy,
  MoreVertical, Send, Ban, Archive, ArchiveRestore, Pin, PinOff, Printer, Loader2,
  Eye, Users, History, BarChart3, Link2, AlertTriangle, ChevronRight,
} from "lucide-react"

type Props = {
  articleId: number | null
  onClose: () => void
  onEdit: (detail: Detail) => void
  onChanged: () => void
  onOpenArticle: (id: number) => void
}

export function ArticleDetailView({ articleId, onClose, onEdit, onChanged, onOpenArticle }: Props) {
  const { data, mutate, isLoading } = useSWR<Detail>(
    articleId ? `/api/knowledge-base/${articleId}` : null,
    fetcher,
  )
  const [busy, setBusy] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState("")
  const [feedbackComment, setFeedbackComment] = useState("")
  const [showFeedbackBox, setShowFeedbackBox] = useState(false)

  const open = articleId != null
  const a = data?.article
  const canManage = data?.canManage ?? false
  const canApprove = data?.canApprove ?? false

  const act = async (action: string, extra?: Record<string, unknown>) => {
    if (!articleId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/knowledge-base/${articleId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      })
      const body = await res.json()
      if (!res.ok) { toast.error(body.error || "Action failed"); return body }
      await mutate()
      onChanged()
      return body
    } catch {
      toast.error("Action failed")
    } finally {
      setBusy(false)
    }
  }

  const doFeedback = async (helpful: boolean) => {
    await act("feedback", { helpful, comment: feedbackComment || undefined })
    toast.success("Thanks for your feedback")
    setShowFeedbackBox(false)
    setFeedbackComment("")
  }

  const doReject = async () => {
    await act("reject", { reason: rejectReason || "Changes requested" })
    setRejectOpen(false)
    setRejectReason("")
    toast.success("Article sent back for changes")
  }

  const doDuplicate = async () => {
    const body = await act("duplicate")
    if (body?.id) { toast.success("Duplicated as draft"); onOpenArticle(body.id) }
  }

  const print = () => window.print()

  const analytics = data?.analytics
  const readPct = analytics && analytics.totalRecipients ? Math.round((analytics.read / analytics.totalRecipients) * 100) : 0
  const ackPct = analytics && analytics.totalRecipients ? Math.round((analytics.acknowledged / analytics.totalRecipients) * 100) : 0

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-3xl">
        {isLoading || !a ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-start gap-3 border-b px-5 py-4">
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <TypeBadge type={a.content_type} />
                  <StatusBadge status={a.status} />
                  {a.article_code && <Badge variant="outline" className="font-mono font-normal">{a.article_code}</Badge>}
                  <Badge variant="ghost" className="font-normal">v{a.version}</Badge>
                  {!!a.pinned && <Badge variant="secondary" className="gap-1 font-normal"><Pin className="size-3" /> Pinned</Badge>}
                  {!!a.important && <Badge variant="secondary" className="gap-1 font-normal text-amber-500"><AlertTriangle className="size-3" /> Important</Badge>}
                </div>
                <h2 className="text-pretty text-lg font-semibold leading-snug">{a.heading}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {a.category_name || "Uncategorized"}
                  {a.author_name ? ` · ${a.author_name}` : ""}
                  {` · Updated ${formatDate(a.updated_at)}`}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost" size="icon" aria-label="Toggle favorite" disabled={busy}
                  onClick={() => act("favorite")}
                >
                  <Star className={data?.userState.isFavorite ? "size-4 fill-amber-400 text-amber-400" : "size-4"} />
                </Button>
                {canManage && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="More actions"><MoreVertical className="size-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => onEdit(data!)}><Pencil className="size-4" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem onClick={doDuplicate}><Copy className="size-4" /> Duplicate</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      {["draft", "rejected"].includes(a.status) && (
                        <DropdownMenuItem onClick={() => act("submit")}><Send className="size-4" /> Submit for review</DropdownMenuItem>
                      )}
                      {canApprove && a.status === "in_review" && (
                        <>
                          <DropdownMenuItem onClick={() => act("approve")}><Check className="size-4" /> Approve & publish</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setRejectOpen(true)}><Ban className="size-4" /> Reject</DropdownMenuItem>
                        </>
                      )}
                      {["draft", "scheduled", "rejected", "in_review"].includes(a.status) && (
                        <DropdownMenuItem onClick={() => act("publish")}><CheckCheck className="size-4" /> Publish now</DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      {a.pinned
                        ? <DropdownMenuItem onClick={() => act("unpin")}><PinOff className="size-4" /> Unpin</DropdownMenuItem>
                        : <DropdownMenuItem onClick={() => act("pin")}><Pin className="size-4" /> Pin to top</DropdownMenuItem>}
                      {a.status === "archived"
                        ? <DropdownMenuItem onClick={() => act("unarchive")}><ArchiveRestore className="size-4" /> Restore to draft</DropdownMenuItem>
                        : <DropdownMenuItem onClick={() => act("archive")}><Archive className="size-4" /> Archive</DropdownMenuItem>}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={print}><Printer className="size-4" /> Print / PDF</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}><X className="size-4" /></Button>
              </div>
            </div>

            {a.status === "rejected" && a.reject_reason && (
              <div className="border-b bg-destructive/10 px-5 py-2.5 text-sm text-destructive">
                <span className="font-medium">Changes requested:</span> {a.reject_reason}
              </div>
            )}
            {!!a.acknowledgement_required && (
              <div className="flex items-center justify-between gap-3 border-b bg-amber-500/10 px-5 py-2.5 text-sm">
                <span className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-4" /> Acknowledgement required
                </span>
                {!canManage && (
                  data?.userState.isAck
                    ? <Badge variant="secondary" className="gap-1"><Check className="size-3" /> Acknowledged</Badge>
                    : <Button size="sm" disabled={busy} onClick={() => { act("acknowledge"); toast.success("Acknowledged") }}>I acknowledge</Button>
                )}
              </div>
            )}

            <Tabs defaultValue="content" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-5 mt-3 w-fit">
                <TabsTrigger value="content">Content</TabsTrigger>
                {(data?.attachments.length || data?.related.length || data?.erpLinks.length) ? <TabsTrigger value="resources">Resources</TabsTrigger> : null}
                {canManage && <TabsTrigger value="versions"><History className="size-3.5" /> History</TabsTrigger>}
                {canManage && analytics && <TabsTrigger value="analytics"><BarChart3 className="size-3.5" /> Analytics</TabsTrigger>}
              </TabsList>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                {/* Content */}
                <TabsContent value="content" className="mt-0">
                  {a.summary && <p className="mb-4 border-l-2 border-primary/40 pl-3 text-sm text-muted-foreground">{a.summary}</p>}
                  <div className="kb-prose text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: a.content }} />

                  {a.tags?.length > 0 && (
                    <div className="mt-5 flex flex-wrap gap-1.5">
                      {a.tags.map((t) => <Badge key={t} variant="secondary" className="font-normal">#{t}</Badge>)}
                    </div>
                  )}

                  <Separator className="my-5" />

                  {/* Meta grid */}
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
                    <Meta label="Audience"><span className="inline-flex items-center gap-1"><Users className="size-3.5 text-muted-foreground" />{AUDIENCE_LABELS[a.audience_type]}</span></Meta>
                    <Meta label="Views"><span className="inline-flex items-center gap-1"><Eye className="size-3.5 text-muted-foreground" />{a.view_count}</span></Meta>
                    <Meta label="Owner">{a.owner_name || "—"}</Meta>
                    <Meta label="Published">{formatDate(a.published_at)}</Meta>
                    <Meta label="Effective">{formatDate(a.effective_date)}</Meta>
                    <Meta label="Review due">{formatDate(a.review_date)}</Meta>
                    <Meta label="Expires">{formatDate(a.expiry_date)}</Meta>
                    <Meta label="Created">{formatDate(a.created_at)}</Meta>
                    <Meta label="Helpful">{a.helpful_count} / {a.helpful_count + a.not_helpful_count}</Meta>
                  </dl>

                  {/* Employee feedback */}
                  {!canManage && a.status === "published" && (
                    <>
                      <Separator className="my-5" />
                      <div className="rounded-lg border bg-card p-4">
                        <p className="mb-3 text-sm font-medium">Was this helpful?</p>
                        <div className="flex items-center gap-2">
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => doFeedback(true)}><ThumbsUp className="size-3.5" /> Yes</Button>
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => setShowFeedbackBox((s) => !s)}><ThumbsDown className="size-3.5" /> No</Button>
                        </div>
                        {showFeedbackBox && (
                          <div className="mt-3 grid gap-2">
                            <Textarea rows={2} placeholder="Tell us what could be improved (optional)" value={feedbackComment} onChange={(e) => setFeedbackComment(e.target.value)} />
                            <Button size="sm" className="w-fit" disabled={busy} onClick={() => doFeedback(false)}>Submit feedback</Button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </TabsContent>

                {/* Resources */}
                <TabsContent value="resources" className="mt-0 grid gap-5">
                  {data && data.attachments.length > 0 && (
                    <section className="grid gap-2">
                      <h3 className="text-sm font-medium">Attachments</h3>
                      {data.attachments.map((att) => (
                        <a
                          key={att.id} href={`/api/knowledge-base/attachments/${att.id}`} target="_blank" rel="noreferrer"
                          className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm transition-colors hover:bg-muted/50"
                        >
                          <Paperclip className="size-3.5 text-muted-foreground" />
                          <span className="flex-1 truncate">{att.file_name}</span>
                          <span className="text-xs text-muted-foreground">{formatBytes(att.file_size)}</span>
                          <Download className="size-3.5 text-muted-foreground" />
                        </a>
                      ))}
                    </section>
                  )}
                  {data && data.related.length > 0 && (
                    <section className="grid gap-2">
                      <h3 className="text-sm font-medium">Related articles</h3>
                      {data.related.map((r) => (
                        <button
                          key={r.id} onClick={() => onOpenArticle(r.id)}
                          className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50"
                        >
                          <span className="flex-1 truncate">{r.heading}</span>
                          <ChevronRight className="size-4 text-muted-foreground" />
                        </button>
                      ))}
                    </section>
                  )}
                  {data && data.erpLinks.length > 0 && (
                    <section className="grid gap-2">
                      <h3 className="text-sm font-medium">Linked ERP records</h3>
                      {data.erpLinks.map((l, i) => (
                        <div key={i} className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
                          <Link2 className="size-3.5 text-muted-foreground" />
                          <span className="flex-1 truncate">{l.label || `${l.source_module} · ${l.source_record_id}`}</span>
                          <Badge variant="outline" className="font-normal">{l.source_module}</Badge>
                        </div>
                      ))}
                    </section>
                  )}
                </TabsContent>

                {/* Version history */}
                {canManage && (
                  <TabsContent value="versions" className="mt-0 grid gap-2">
                    {data && data.versions.length === 0 && <p className="text-sm text-muted-foreground">No previous versions.</p>}
                    {data?.versions.map((v) => (
                      <div key={v.version} className="flex items-start gap-3 rounded-md border bg-card px-3 py-2.5 text-sm">
                        <Badge variant="ghost" className="font-normal">v{v.version}</Badge>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{v.change_summary || v.heading}</p>
                          <p className="text-xs text-muted-foreground">{v.edited_by_name || "—"} · {formatDateTime(v.edited_at)}</p>
                        </div>
                      </div>
                    ))}
                  </TabsContent>
                )}

                {/* Analytics */}
                {canManage && analytics && (
                  <TabsContent value="analytics" className="mt-0 grid gap-5">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Stat label="Recipients" value={analytics.totalRecipients} />
                      <Stat label="Read" value={`${analytics.read} (${readPct}%)`} />
                      <Stat label="Acknowledged" value={`${analytics.acknowledged} (${ackPct}%)`} />
                      <Stat label="Unread" value={analytics.unread} />
                      <Stat label="Emails sent" value={analytics.emailSent} />
                      <Stat label="In-app sent" value={analytics.inAppSent} />
                      <Stat label="Helpful" value={analytics.helpful} />
                      <Stat label="Not helpful" value={analytics.notHelpful} />
                    </div>

                    {data && data.recipientStatus.length > 0 && (
                      <section className="grid gap-2">
                        <h3 className="text-sm font-medium">Recipient status</h3>
                        <div className="overflow-hidden rounded-lg border">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                                <th className="px-3 py-2 font-medium">Employee</th>
                                <th className="px-3 py-2 font-medium">Department</th>
                                <th className="px-3 py-2 font-medium">Read</th>
                                <th className="px-3 py-2 font-medium">Acknowledged</th>
                              </tr>
                            </thead>
                            <tbody>
                              {data.recipientStatus.map((r) => (
                                <tr key={r.id} className="border-b last:border-0">
                                  <td className="px-3 py-2">{r.employee_name}</td>
                                  <td className="px-3 py-2 text-muted-foreground">{r.department || "—"}</td>
                                  <td className="px-3 py-2">{r.read_at ? <Check className="size-4 text-emerald-500" /> : <span className="text-muted-foreground">—</span>}</td>
                                  <td className="px-3 py-2">{r.acknowledged_at ? <Check className="size-4 text-emerald-500" /> : <span className="text-muted-foreground">—</span>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                    )}

                    {data && data.feedback.length > 0 && (
                      <section className="grid gap-2">
                        <h3 className="text-sm font-medium">Feedback comments</h3>
                        {data.feedback.filter((f) => f.comment).map((f) => (
                          <div key={f.id} className="rounded-md border bg-card px-3 py-2 text-sm">
                            <span className={f.helpful ? "text-emerald-500" : "text-destructive"}>
                              {f.helpful ? <ThumbsUp className="mr-1 inline size-3.5" /> : <ThumbsDown className="mr-1 inline size-3.5" />}
                            </span>
                            {f.comment}
                            <span className="ml-2 text-xs text-muted-foreground">{formatDate(f.created_at)}</span>
                          </div>
                        ))}
                      </section>
                    )}
                  </TabsContent>
                )}
              </div>
            </Tabs>
          </>
        )}
      </SheetContent>

      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject article</AlertDialogTitle>
            <AlertDialogDescription>Let the author know what needs to change. This is recorded on the article.</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea rows={3} placeholder="Reason for rejection" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doReject}>Reject</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
    </div>
  )
}
