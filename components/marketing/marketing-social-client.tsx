"use client"

import * as React from "react"
import {
  Search,
  Plus,
  MoreVertical,
  Send,
  CalendarClock,
  CheckCircle2,
  Loader2,
  LinkIcon,
  Unlink,
  Share2,
  FileText,
  Users,
  Sparkles,
  X,
} from "lucide-react"

import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

/* ------------------------------------------------------------------ */
/* Platform catalog                                                    */
/* ------------------------------------------------------------------ */

type PlatformId =
  | "linkedin"
  | "instagram"
  | "x"
  | "facebook"
  | "youtube"
  | "threads"
  | "tiktok"
  | "pinterest"

type Platform = {
  id: PlatformId
  name: string
  abbr: string
  color: string
  /** max characters allowed for a post on this platform */
  limit: number
}

const PLATFORMS: Platform[] = [
  { id: "linkedin", name: "LinkedIn", abbr: "in", color: "#0A66C2", limit: 3000 },
  { id: "instagram", name: "Instagram", abbr: "Ig", color: "#E4405F", limit: 2200 },
  { id: "x", name: "X (Twitter)", abbr: "X", color: "#111827", limit: 280 },
  { id: "facebook", name: "Facebook", abbr: "f", color: "#1877F2", limit: 63206 },
  { id: "youtube", name: "YouTube", abbr: "YT", color: "#FF0000", limit: 5000 },
  { id: "threads", name: "Threads", abbr: "Th", color: "#000000", limit: 500 },
  { id: "tiktok", name: "TikTok", abbr: "Tk", color: "#EE1D52", limit: 2200 },
  { id: "pinterest", name: "Pinterest", abbr: "P", color: "#BD081C", limit: 500 },
]

const platformById = (id: PlatformId) => PLATFORMS.find((p) => p.id === id)!

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type Account = {
  platform: PlatformId
  handle: string
  followers: number
  connectedAt: string
}

type PostStatus = "Draft" | "Scheduled" | "Publishing" | "Published" | "Failed"

type SocialPost = {
  id: string
  name: string
  content: string
  targets: PlatformId[]
  status: PostStatus
  folder: string
  createdAt: string
  publishedAt?: string
}

/* ------------------------------------------------------------------ */
/* Seed data                                                           */
/* ------------------------------------------------------------------ */

const INITIAL_ACCOUNTS: Account[] = [
  { platform: "linkedin", handle: "@muenot", followers: 12400, connectedAt: "2026-08-02" },
  { platform: "instagram", handle: "@muenot.official", followers: 8600, connectedAt: "2026-08-10" },
  { platform: "x", handle: "@muenot", followers: 5200, connectedAt: "2026-08-14" },
]

const INITIAL_POSTS: SocialPost[] = [
  {
    id: "SOC-101",
    name: "Product launch teaser",
    content: "Something big is coming. Stay tuned for our biggest release yet.",
    targets: ["linkedin", "x"],
    status: "Published",
    folder: "Launches",
    createdAt: "2026-09-09T10:20:00",
    publishedAt: "2026-09-09T11:00:00",
  },
  {
    id: "SOC-102",
    name: "Behind the scenes reel",
    content: "A peek inside how our team ships every week.",
    targets: ["instagram"],
    status: "Scheduled",
    folder: "Unclassified",
    createdAt: "2026-09-10T09:15:00",
  },
  {
    id: "SOC-103",
    name: "Test",
    content: "This is a draft social campaign.",
    targets: ["linkedin"],
    status: "Draft",
    folder: "Unclassified",
    createdAt: "2026-09-11T00:49:00",
  },
]

const STATUS_STYLES: Record<PostStatus, string> = {
  Draft: "bg-muted text-muted-foreground",
  Scheduled: "bg-chart-4/15 text-chart-4",
  Publishing: "bg-chart-1/15 text-chart-1",
  Published: "bg-chart-2/15 text-chart-2",
  Failed: "bg-destructive/15 text-destructive",
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                        */
/* ------------------------------------------------------------------ */

function PlatformBadge({ id, size = "sm" }: { id: PlatformId; size?: "sm" | "md" }) {
  const p = platformById(id)
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold text-white",
        size === "sm" ? "size-6 text-[10px]" : "size-9 text-xs",
      )}
      style={{ backgroundColor: p.color }}
      title={p.name}
      aria-label={p.name}
    >
      {p.abbr}
    </span>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function formatCount(n: number) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`
  return String(n)
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function MarketingSocialClient() {
  const [accounts, setAccounts] = React.useState<Account[]>(INITIAL_ACCOUNTS)
  const [posts, setPosts] = React.useState<SocialPost[]>(INITIAL_POSTS)

  const [folder, setFolder] = React.useState("all")
  const [statusFilter, setStatusFilter] = React.useState("all")
  const [query, setQuery] = React.useState("")

  const connectedIds = accounts.map((a) => a.platform)
  const folders = React.useMemo(
    () => Array.from(new Set(posts.map((p) => p.folder))),
    [posts],
  )

  const filtered = posts.filter((p) => {
    const byFolder = folder === "all" || p.folder === folder
    const byStatus = statusFilter === "all" || p.status === statusFilter
    const byQuery = p.name.toLowerCase().includes(query.toLowerCase())
    return byFolder && byStatus && byQuery
  })

  /* ---- account actions ---- */
  function connect(platform: PlatformId, handle: string) {
    setAccounts((prev) => [
      ...prev.filter((a) => a.platform !== platform),
      {
        platform,
        handle: handle.startsWith("@") ? handle : `@${handle}`,
        followers: Math.floor(1000 + Math.random() * 20000),
        connectedAt: new Date().toISOString().slice(0, 10),
      },
    ])
  }
  function disconnect(platform: PlatformId) {
    setAccounts((prev) => prev.filter((a) => a.platform !== platform))
  }

  /* ---- post actions ---- */
  function addPost(post: SocialPost) {
    setPosts((prev) => [post, ...prev])
  }
  function clonePost(id: string) {
    setPosts((prev) => {
      const src = prev.find((p) => p.id === id)
      if (!src) return prev
      const copy: SocialPost = {
        ...src,
        id: `SOC-${Math.floor(100 + Math.random() * 900)}`,
        name: `${src.name} (copy)`,
        status: "Draft",
        createdAt: new Date().toISOString(),
        publishedAt: undefined,
      }
      return [copy, ...prev]
    })
  }
  function deletePost(id: string) {
    setPosts((prev) => prev.filter((p) => p.id !== id))
  }

  /** Simulated publish pipeline: Publishing -> Published after a short delay. */
  function publishPost(id: string) {
    setPosts((prev) => prev.map((p) => (p.id === id ? { ...p, status: "Publishing" } : p)))
    window.setTimeout(() => {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === id
            ? { ...p, status: "Published", publishedAt: new Date().toISOString() }
            : p,
        ),
      )
    }, 1600)
  }

  const publishedCount = posts.filter((p) => p.status === "Published").length
  const totalReach = accounts.reduce((s, a) => s + a.followers, 0)

  return (
    <div className="space-y-6 p-6">
      <MarketingHeader
        eyebrow="Marketing Campaigns"
        title="Social Campaigns"
        description="Connect your social accounts and publish posts straight to every connected platform from one place."
        action={
          <ComposeDialog
            connectedIds={connectedIds}
            folders={folders}
            onCreate={addPost}
            onPublish={publishPost}
          />
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Connected Accounts" value={accounts.length} icon={LinkIcon} hint={`${PLATFORMS.length} platforms available`} />
        <StatCard label="Total Reach" value={formatCount(totalReach)} icon={Users} hint="Across connected networks" />
        <StatCard label="Posts" value={posts.length} icon={FileText} hint={`${posts.filter((p) => p.status === "Draft").length} drafts`} />
        <StatCard label="Published" value={publishedCount} icon={CheckCircle2} hint="Live on platforms" />
      </div>

      <Tabs defaultValue="campaigns">
        <TabsList>
          <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
          <TabsTrigger value="accounts">Connected Accounts</TabsTrigger>
        </TabsList>

        {/* ------------------------------ Campaigns ------------------------------ */}
        <TabsContent value="campaigns">
          <Card>
            <CardHeader className="gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-base font-medium">
                  {filtered.length} Social {filtered.length === 1 ? "Campaign" : "Campaigns"} in this view
                </CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={folder} onValueChange={setFolder}>
                    <SelectTrigger className="h-9 w-40" aria-label="Filter by folder">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Folders</SelectItem>
                      {folders.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={statusFilter} onValueChange={setStatusFilter}>
                    <SelectTrigger className="h-9 w-32" aria-label="Filter by status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="Draft">Draft</SelectItem>
                      <SelectItem value="Scheduled">Scheduled</SelectItem>
                      <SelectItem value="Published">Published</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="I'm searching for"
                      className="h-9 w-56 pl-8"
                    />
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-3 pb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                <span>Social Campaign Name</span>
                <span className="pr-8">Status</span>
              </div>

              {filtered.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
                  <Share2 className="size-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No campaigns match your filters.</p>
                </div>
              ) : (
                filtered.map((post) => (
                  <PostRow
                    key={post.id}
                    post={post}
                    onClone={() => clonePost(post.id)}
                    onDelete={() => deletePost(post.id)}
                    onPublish={() => publishPost(post.id)}
                  />
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------ Accounts ------------------------------ */}
        <TabsContent value="accounts">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PLATFORMS.map((p) => {
              const account = accounts.find((a) => a.platform === p.id)
              return (
                <Card key={p.id}>
                  <CardContent className="flex flex-col gap-4 pt-6">
                    <div className="flex items-center gap-3">
                      <PlatformBadge id={p.id} size="md" />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{p.name}</p>
                        {account ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {account.handle} · {formatCount(account.followers)} followers
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">Not connected</p>
                        )}
                      </div>
                    </div>
                    {account ? (
                      <div className="flex items-center justify-between">
                        <Badge className="bg-chart-2/15 text-chart-2">Connected</Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
                          onClick={() => disconnect(p.id)}
                        >
                          <Unlink className="size-4" />
                          Disconnect
                        </Button>
                      </div>
                    ) : (
                      <ConnectDialog platform={p} onConnect={connect} />
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Post row                                                            */
/* ------------------------------------------------------------------ */

function PostRow({
  post,
  onClone,
  onDelete,
  onPublish,
}: {
  post: SocialPost
  onClone: () => void
  onDelete: () => void
  onPublish: () => void
}) {
  const canPublish = post.status === "Draft" || post.status === "Scheduled" || post.status === "Failed"
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 rounded-lg border p-3 transition-colors hover:bg-muted/40">
      <div className="min-w-0 space-y-1.5">
        <div className="flex items-center gap-2">
          <p className="truncate font-medium">{post.name}</p>
          <div className="flex items-center gap-1">
            {post.targets.map((t) => (
              <PlatformBadge key={t} id={t} />
            ))}
          </div>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          Created on {formatDate(post.createdAt)}
          {post.publishedAt ? ` · Published ${formatDate(post.publishedAt)}` : ""}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Badge className={cn("gap-1", STATUS_STYLES[post.status])}>
          {post.status === "Publishing" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : post.status === "Published" ? (
            <CheckCircle2 className="size-3" />
          ) : post.status === "Scheduled" ? (
            <CalendarClock className="size-3" />
          ) : (
            <FileText className="size-3" />
          )}
          {post.status}
        </Badge>

        {canPublish ? (
          <Button size="sm" onClick={onPublish}>
            <Send className="size-4" />
            Publish
          </Button>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="Row actions">
                <MoreVertical className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onClone}>Clone</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Connect dialog                                                      */
/* ------------------------------------------------------------------ */

function ConnectDialog({
  platform,
  onConnect,
}: {
  platform: Platform
  onConnect: (id: PlatformId, handle: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [handle, setHandle] = React.useState("")

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="w-full">
            <LinkIcon className="size-4" />
            Connect
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <PlatformBadge id={platform.id} size="md" />
            <div>
              <DialogTitle>Connect {platform.name}</DialogTitle>
              <DialogDescription>Authorize the account to publish from this ERP.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="handle">Account handle</Label>
          <Input
            id="handle"
            placeholder={`@your-${platform.id}-handle`}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Demo mode — this simulates the OAuth authorization step without leaving the app.
          </p>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={!handle.trim()}
            onClick={() => {
              onConnect(platform.id, handle.trim())
              setHandle("")
              setOpen(false)
            }}
          >
            Authorize &amp; Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Compose dialog                                                      */
/* ------------------------------------------------------------------ */

function ComposeDialog({
  connectedIds,
  folders,
  onCreate,
  onPublish,
}: {
  connectedIds: PlatformId[]
  folders: string[]
  onCreate: (post: SocialPost) => void
  onPublish: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [content, setContent] = React.useState("")
  const [targets, setTargets] = React.useState<PlatformId[]>([])

  const reset = () => {
    setName("")
    setContent("")
    setTargets([])
  }

  const toggleTarget = (id: PlatformId) =>
    setTargets((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]))

  // Tightest character limit across the selected platforms.
  const activeLimit = targets.length
    ? Math.min(...targets.map((t) => platformById(t).limit))
    : null
  const overLimit = activeLimit !== null && content.length > activeLimit

  const canSubmit = name.trim().length > 0 && content.trim().length > 0

  function build(status: PostStatus): SocialPost {
    return {
      id: `SOC-${Math.floor(100 + Math.random() * 900)}`,
      name: name.trim(),
      content: content.trim(),
      targets,
      status,
      folder: "Unclassified",
      createdAt: new Date().toISOString(),
    }
  }

  function saveDraft() {
    onCreate(build("Draft"))
    reset()
    setOpen(false)
  }

  function publishNow() {
    const post = build("Publishing")
    onCreate(post)
    // kick off the simulated pipeline on the freshly created post
    window.setTimeout(() => onPublish(post.id), 50)
    reset()
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset() }}>
      <DialogTrigger
        render={
          <Button>
            <Plus className="size-4" />
            Create
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Social Post</DialogTitle>
          <DialogDescription>
            Write once and publish to every selected connected platform.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="post-name">Campaign name</Label>
            <Input
              id="post-name"
              placeholder="e.g. Autumn product launch"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Publish to</Label>
            {connectedIds.length === 0 ? (
              <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                No accounts connected yet. Connect one from the Connected Accounts tab to publish.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {connectedIds.map((id) => {
                  const active = targets.includes(id)
                  const p = platformById(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleTarget(id)}
                      className={cn(
                        "flex items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm transition-colors",
                        active
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      <PlatformBadge id={id} />
                      {p.name}
                      {active ? <X className="size-3.5" /> : null}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="post-content">Post content</Label>
              {activeLimit !== null ? (
                <span className={cn("text-xs", overLimit ? "text-destructive" : "text-muted-foreground")}>
                  {content.length}/{activeLimit}
                </span>
              ) : null}
            </div>
            <Textarea
              id="post-content"
              rows={5}
              placeholder="What do you want to share?"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
            {overLimit ? (
              <p className="text-xs text-destructive">
                Content exceeds the limit for the tightest selected platform.
              </p>
            ) : (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Sparkles className="size-3" />
                Tip: keep it under 280 characters to fit every platform.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={saveDraft} disabled={!canSubmit}>
            Save Draft
          </Button>
          <Button
            onClick={publishNow}
            disabled={!canSubmit || targets.length === 0 || overLimit}
          >
            <Send className="size-4" />
            Publish Now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
