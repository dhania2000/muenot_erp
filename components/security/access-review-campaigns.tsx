"use client"

import { useMemo, useState } from "react"
import { CalendarClock, ClipboardCheck, Plus } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/security/security-ui"

const SCOPES = ["Users", "Roles", "Permissions", "Temporary access", "API keys", "Service accounts"] as const
const RECURRENCES = ["One time", "Monthly", "Quarterly", "Annually"] as const

type ReviewItem = {
  id: string
  subject: string
  currentAccess: string
  context: string
  lastReviewed: string
  decision: "pending" | "certified" | "revoked" | "remediate"
  comment: string
}

type Campaign = {
  id: string
  name: string
  reviewer: string
  startDate: string
  dueDate: string
  recurrence: string
  scope: string[]
  items: ReviewItem[]
}

function isOverdue(campaign: Campaign) {
  if (!campaign.dueDate) return false
  return new Date(campaign.dueDate).getTime() < Date.now() && campaign.items.some((i) => i.decision === "pending")
}

function progressOf(campaign: Campaign) {
  const total = campaign.items.length
  const reviewed = campaign.items.filter((i) => i.decision !== "pending").length
  return { total, reviewed, remaining: total - reviewed }
}

export function AccessReviewCampaigns({
  candidates,
}: {
  candidates: { id: string; name: string; email: string; role: string }[]
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [reviewing, setReviewing] = useState<Campaign | null>(null)
  const [tab, setTab] = useState("campaigns")

  const [name, setName] = useState("")
  const [reviewer, setReviewer] = useState("")
  const [startDate, setStartDate] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [recurrence, setRecurrence] = useState<string>(RECURRENCES[0])
  const [scope, setScope] = useState<string[]>(["Users"])

  const overdue = useMemo(() => campaigns.filter(isOverdue), [campaigns])
  const completed = useMemo(
    () => campaigns.filter((c) => c.items.length > 0 && c.items.every((i) => i.decision !== "pending")),
    [campaigns],
  )

  function toggleScope(s: string) {
    setScope((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
  }

  function createCampaign() {
    const items: ReviewItem[] = candidates.map((c) => ({
      id: c.id,
      subject: `${c.name} (${c.email})`,
      currentAccess: c.role,
      context: "Elevated access — from current directory snapshot",
      lastReviewed: "Never",
      decision: "pending",
      comment: "",
    }))
    setCampaigns((all) => [
      ...all,
      { id: crypto.randomUUID(), name, reviewer, startDate, dueDate, recurrence, scope, items },
    ])
    setCreateOpen(false)
    setName("")
    setReviewer("")
    setStartDate("")
    setDueDate("")
    setScope(["Users"])
  }

  function decide(campaignId: string, itemId: string, decision: ReviewItem["decision"], comment: string) {
    setCampaigns((all) =>
      all.map((c) =>
        c.id !== campaignId
          ? c
          : {
              ...c,
              items: c.items.map((i) => (i.id === itemId ? { ...i, decision, comment } : i)),
            },
      ),
    )
    setReviewing((r) => {
      if (!r || r.id !== campaignId) return r
      return { ...r, items: r.items.map((i) => (i.id === itemId ? { ...i, decision, comment } : i)) }
    })
  }

  function CampaignTable({ list }: { list: Campaign[] }) {
    if (list.length === 0) {
      return (
        <EmptyState icon={<ClipboardCheck className="size-5" />} title="No campaigns in this view">
          Create a review campaign to start certifying access.
        </EmptyState>
      )
    }
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Campaign name</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Reviewer</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((c) => {
              const p = progressOf(c)
              const overdueFlag = isOverdue(c)
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.scope.join(", ")}</TableCell>
                  <TableCell>{c.reviewer}</TableCell>
                  <TableCell className="text-muted-foreground">{c.startDate || "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{c.dueDate || "—"}</TableCell>
                  <TableCell className="w-32">
                    <Progress value={p.total ? (p.reviewed / p.total) * 100 : 0} className="h-1.5" />
                    <span className="text-[11px] text-muted-foreground">
                      {p.reviewed}/{p.total} reviewed
                    </span>
                  </TableCell>
                  <TableCell>
                    {overdueFlag ? (
                      <Badge variant="destructive">Overdue</Badge>
                    ) : p.remaining === 0 && p.total > 0 ? (
                      <Badge className="border-transparent bg-emerald-600 text-white">Completed</Badge>
                    ) : (
                      <Badge variant="outline">In progress</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => setReviewing(c)}>
                      Review
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    )
  }

  const reviewProgress = reviewing ? progressOf(reviewing) : null
  const currentReviewing = reviewing ? campaigns.find((c) => c.id === reviewing.id) ?? reviewing : null

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Access review campaigns</CardTitle>
          <CardDescription>Spec 66 — periodically re-certify elevated access.</CardDescription>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" /> Create campaign
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="flex w-full flex-wrap justify-start gap-1 sm:w-auto">
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="my-reviews">My reviews</TabsTrigger>
            <TabsTrigger value="overdue">
              Overdue{overdue.length > 0 && <Badge variant="destructive" className="ml-1.5 text-[10px]">{overdue.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="completed">Completed</TabsTrigger>
          </TabsList>
          <TabsContent value="campaigns" className="pt-4">
            <CampaignTable list={campaigns} />
          </TabsContent>
          <TabsContent value="my-reviews" className="pt-4">
            <CampaignTable list={campaigns.filter((c) => c.items.some((i) => i.decision === "pending"))} />
          </TabsContent>
          <TabsContent value="overdue" className="pt-4">
            <CampaignTable list={overdue} />
          </TabsContent>
          <TabsContent value="completed" className="pt-4">
            <CampaignTable list={completed} />
          </TabsContent>
        </Tabs>
      </CardContent>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create review campaign</DialogTitle>
            <DialogDescription>Assign a reviewer and due date for a batch of access to certify.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="camp-name">Campaign name</Label>
              <Input id="camp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q1 elevated access review" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="camp-reviewer">Reviewer</Label>
                <Input id="camp-reviewer" value={reviewer} onChange={(e) => setReviewer(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="camp-recurrence">Recurrence</Label>
                <Select value={recurrence} onValueChange={setRecurrence}>
                  <SelectTrigger id="camp-recurrence" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECURRENCES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="camp-start">Start date</Label>
                <Input id="camp-start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="camp-due">Due date</Label>
                <Input id="camp-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
              </div>
            </div>
            <fieldset className="grid gap-2">
              <legend className="text-sm font-medium">Scope</legend>
              <div className="grid grid-cols-2 gap-1.5">
                {SCOPES.map((s) => (
                  <label key={s} className="flex items-center gap-2 rounded-md border p-2 text-xs">
                    <input
                      type="checkbox"
                      checked={scope.includes(s)}
                      onChange={() => toggleScope(s)}
                      className="size-3.5"
                    />
                    {s}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createCampaign} disabled={!name.trim() || !reviewer.trim()}>
              Create campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reviewing !== null} onOpenChange={(open) => !open && setReviewing(null)}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{currentReviewing?.name}</DialogTitle>
            <DialogDescription className="flex items-center gap-1.5">
              <CalendarClock className="size-3.5" /> Due {currentReviewing?.dueDate || "—"} · Reviewer{" "}
              {currentReviewing?.reviewer}
            </DialogDescription>
          </DialogHeader>
          {reviewProgress && (
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-md border p-3 text-center">
                <p className="text-lg font-semibold">{reviewProgress.reviewed}</p>
                <p className="text-xs text-muted-foreground">Reviewed</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-lg font-semibold">{reviewProgress.remaining}</p>
                <p className="text-xs text-muted-foreground">Remaining</p>
              </div>
              <div className="rounded-md border p-3 text-center">
                <p className="text-lg font-semibold">{isOverdue(currentReviewing!) ? "Yes" : "No"}</p>
                <p className="text-xs text-muted-foreground">Overdue</p>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {currentReviewing?.items.map((item) => (
              <div key={item.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{item.subject}</p>
                    <p className="text-xs text-muted-foreground">
                      Current access: {item.currentAccess} · Last reviewed: {item.lastReviewed}
                    </p>
                    <p className="text-xs text-muted-foreground">{item.context}</p>
                  </div>
                  <Badge
                    variant={item.decision === "pending" ? "outline" : "default"}
                    className={item.decision === "revoked" ? "bg-destructive text-white" : undefined}
                  >
                    {item.decision}
                  </Badge>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant={item.decision === "certified" ? "default" : "outline"}
                    onClick={() => decide(currentReviewing.id, item.id, "certified", item.comment)}
                  >
                    Certify
                  </Button>
                  <Button
                    size="sm"
                    variant={item.decision === "revoked" ? "default" : "outline"}
                    className={item.decision === "revoked" ? "bg-destructive text-white hover:bg-destructive/90" : undefined}
                    onClick={() => decide(currentReviewing.id, item.id, "revoked", item.comment)}
                  >
                    Revoke
                  </Button>
                  <Button
                    size="sm"
                    variant={item.decision === "remediate" ? "default" : "outline"}
                    onClick={() => decide(currentReviewing.id, item.id, "remediate", item.comment)}
                  >
                    Remediate
                  </Button>
                  <Input
                    placeholder="Optional comment"
                    className="h-8 flex-1 min-w-32"
                    value={item.comment}
                    onChange={(e) => decide(currentReviewing.id, item.id, item.decision, e.target.value)}
                  />
                </div>
              </div>
            ))}
            {currentReviewing?.items.length === 0 && (
              <EmptyState icon={<ClipboardCheck className="size-5" />} title="No items in scope for this campaign" />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
