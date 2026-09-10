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
  Building2,
  User,
  Sparkles,
  X,
  ChevronLeft,
  Megaphone,
  Smile,
  ImageUp,
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

type AccountType = "company" | "personal"

type Account = {
  id: string
  platform: PlatformId
  type: AccountType
  handle: string
  /** employee name — only set for personal accounts */
  owner?: string
  followers: number
  connectedAt: string
}

type PostStatus = "Draft" | "Scheduled" | "Publishing" | "Published" | "Failed"

type SocialPost = {
  id: string
  name: string
  content: string
  targets: PlatformId[]
  /** specific connected accounts selected for this post */
  accountIds?: string[]
  /** optional attached image (object URL / data URL) */
  image?: string
  brand?: string
  status: PostStatus
  folder: string
  createdAt: string
  publishedAt?: string
}

const BRANDS = ["Muenot Technologies", "Muenot Labs", "Muenot Academy"]

/* ------------------------------------------------------------------ */
/* Seed data                                                           */
/* ------------------------------------------------------------------ */

const INITIAL_ACCOUNTS: Account[] = [
  { id: "ACC-1", platform: "linkedin", type: "company", handle: "@muenot", followers: 12400, connectedAt: "2026-08-02" },
  { id: "ACC-2", platform: "instagram", type: "company", handle: "@muenot.official", followers: 8600, connectedAt: "2026-08-10" },
  { id: "ACC-3", platform: "x", type: "company", handle: "@muenot", followers: 5200, connectedAt: "2026-08-14" },
  { id: "ACC-4", platform: "linkedin", type: "personal", handle: "@priya.sharma", owner: "Priya Sharma", followers: 3200, connectedAt: "2026-08-20" },
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
  const [composing, setComposing] = React.useState(false)

  const connectedIds = Array.from(new Set(accounts.map((a) => a.platform)))
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
  function connect(input: { platform: PlatformId; type: AccountType; handle: string; owner?: string }) {
    setAccounts((prev) => [
      ...prev,
      {
        id: `ACC-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        platform: input.platform,
        type: input.type,
        handle: input.handle.startsWith("@") ? input.handle : `@${input.handle}`,
        owner: input.owner?.trim() ? input.owner.trim() : undefined,
        followers: Math.floor(1000 + Math.random() * 20000),
        connectedAt: new Date().toISOString().slice(0, 10),
      },
    ])
  }
  function disconnect(id: string) {
    setAccounts((prev) => prev.filter((a) => a.id !== id))
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

  if (composing) {
    return (
      <ComposeWizard
        accounts={accounts}
        onCancel={() => setComposing(false)}
        onCreate={addPost}
        onPublish={publishPost}
      />
    )
  }

  return (
    <div className="space-y-6 p-6">
      <MarketingHeader
        eyebrow="Marketing Campaigns"
        title="Social Campaigns"
        description="Connect your social accounts and publish posts straight to every connected platform from one place."
        action={
          <Button onClick={() => setComposing(true)}>
            <Plus className="size-4" />
            Create
          </Button>
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
        <TabsContent value="accounts" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Connect a company page to publish as the brand, or let employees link their own accounts to
            post under their name. You can connect multiple accounts per platform.
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PLATFORMS.map((p) => {
              const list = accounts.filter((a) => a.platform === p.id)
              return (
                <Card key={p.id}>
                  <CardContent className="flex flex-col gap-4 pt-6">
                    <div className="flex items-center gap-3">
                      <PlatformBadge id={p.id} size="md" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {list.length === 0
                            ? "Not connected"
                            : `${list.length} account${list.length > 1 ? "s" : ""} connected`}
                        </p>
                      </div>
                      {list.length > 0 ? (
                        <Badge className="bg-chart-2/15 text-chart-2">Active</Badge>
                      ) : null}
                    </div>

                    {list.length > 0 ? (
                      <ul className="space-y-2">
                        {list.map((account) => (
                          <li
                            key={account.id}
                            className="flex items-center justify-between gap-2 rounded-lg border p-2.5"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-sm font-medium">{account.handle}</span>
                                <Badge variant="outline" className="shrink-0 gap-1 text-[10px] font-normal">
                                  {account.type === "company" ? (
                                    <>
                                      <Building2 className="size-3" />
                                      Company
                                    </>
                                  ) : (
                                    <>
                                      <User className="size-3" />
                                      {account.owner ?? "Employee"}
                                    </>
                                  )}
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground">
                                {formatCount(account.followers)} followers
                              </p>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-muted-foreground"
                              onClick={() => disconnect(account.id)}
                              aria-label={`Disconnect ${account.handle}`}
                            >
                              <Unlink className="size-4" />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <ConnectDialog platform={p} onConnect={connect} hasAccounts={list.length > 0} />
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
  hasAccounts,
}: {
  platform: Platform
  onConnect: (input: { platform: PlatformId; type: AccountType; handle: string; owner?: string }) => void
  hasAccounts: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [type, setType] = React.useState<AccountType>("company")
  const [handle, setHandle] = React.useState("")
  const [owner, setOwner] = React.useState("")

  const reset = () => {
    setType("company")
    setHandle("")
    setOwner("")
  }

  const canSubmit = handle.trim().length > 0 && (type === "company" || owner.trim().length > 0)

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset() }}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" className="w-full">
            {hasAccounts ? <Plus className="size-4" /> : <LinkIcon className="size-4" />}
            {hasAccounts ? "Add another account" : "Connect"}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <PlatformBadge id={platform.id} size="md" />
            <div>
              <DialogTitle>Connect {platform.name}</DialogTitle>
              <DialogDescription>Authorize an account to publish from this ERP.</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Account type</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setType("company")}
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-3 text-sm transition-colors",
                  type === "company"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                <Building2 className="size-4" />
                Company page
              </button>
              <button
                type="button"
                onClick={() => setType("personal")}
                className={cn(
                  "flex items-center gap-2 rounded-lg border p-3 text-sm transition-colors",
                  type === "personal"
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                <User className="size-4" />
                Employee account
              </button>
            </div>
          </div>

          {type === "personal" ? (
            <div className="space-y-2">
              <Label htmlFor={`owner-${platform.id}`}>Employee name</Label>
              <Input
                id={`owner-${platform.id}`}
                placeholder="e.g. Priya Sharma"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor={`handle-${platform.id}`}>
              {type === "company" ? "Page handle" : "Account handle"}
            </Label>
            <Input
              id={`handle-${platform.id}`}
              placeholder={`@your-${platform.id}-handle`}
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {type === "company"
                ? "Directly connect your company page to publish as the brand."
                : "Employees can connect their own account to publish under their name."}
            </p>
          </div>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button
            disabled={!canSubmit}
            onClick={() => {
              onConnect({
                platform: platform.id,
                type,
                handle: handle.trim(),
                owner: type === "personal" ? owner.trim() : undefined,
              })
              reset()
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
/* Compose wizard (full page)                                          */
/* ------------------------------------------------------------------ */

const EMOJIS = ["😀", "😎", "🚀", "🎉", "🔥", "💡", "👏", "❤️", "✅", "📢", "📈", "🙌", "✨", "🎯", "💬", "👀"]

function AccountAvatar({ account, size = "md" }: { account: Account; size?: "sm" | "md" }) {
  const p = platformById(account.platform)
  const initial = (account.owner ?? account.handle.replace(/^@/, "")).charAt(0).toUpperCase()
  const dim = size === "sm" ? "size-8 text-xs" : "size-12 text-base"
  return (
    <span className={cn("relative inline-flex shrink-0", size === "sm" ? "size-8" : "size-12")}>
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-muted font-semibold text-foreground",
          dim,
        )}
      >
        {initial}
      </span>
      <span
        className="absolute -right-0.5 -bottom-0.5 inline-flex size-4 items-center justify-center rounded-full text-[8px] font-semibold text-white ring-2 ring-background"
        style={{ backgroundColor: p.color }}
        title={p.name}
      >
        {p.abbr}
      </span>
    </span>
  )
}

function ComposeWizard({
  accounts,
  onCancel,
  onCreate,
  onPublish,
}: {
  accounts: Account[]
  onCancel: () => void
  onCreate: (post: SocialPost) => void
  onPublish: (id: string) => void
}) {
  const [step, setStep] = React.useState<1 | 2>(1)

  // step 1
  const [name, setName] = React.useState("")
  const [brand, setBrand] = React.useState("")
  const [nameTouched, setNameTouched] = React.useState(false)

  // step 2
  const [selectedAccounts, setSelectedAccounts] = React.useState<string[]>([])
  const [content, setContent] = React.useState("")
  const [image, setImage] = React.useState<string | undefined>(undefined)
  const [showEmoji, setShowEmoji] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const nameValid = name.trim().length > 0

  const toggleAccount = (id: string) =>
    setSelectedAccounts((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]))

  const chosen = accounts.filter((a) => selectedAccounts.includes(a.id))
  const targets = Array.from(new Set(chosen.map((a) => a.platform)))
  const activeLimit = targets.length ? Math.min(...targets.map((t) => platformById(t).limit)) : null
  const overLimit = activeLimit !== null && content.length > activeLimit

  const canProceed = selectedAccounts.length > 0 && content.trim().length > 0 && !overLimit

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImage(URL.createObjectURL(file))
  }

  function build(status: PostStatus): SocialPost {
    return {
      id: `SOC-${Math.floor(100 + Math.random() * 900)}`,
      name: name.trim(),
      content: content.trim(),
      targets,
      accountIds: selectedAccounts,
      image,
      brand: brand || undefined,
      status,
      folder: "Unclassified",
      createdAt: new Date().toISOString(),
    }
  }

  function saveDraft() {
    onCreate(build("Draft"))
    onCancel()
  }

  function publishNow() {
    const post = build("Publishing")
    onCreate(post)
    window.setTimeout(() => onPublish(post.id), 50)
    onCancel()
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4 border-b p-6">
        <div className="flex items-start gap-3">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back"
            onClick={() => (step === 2 ? setStep(1) : onCancel())}
          >
            <ChevronLeft className="size-5" />
          </Button>
          <div>
            <p className="text-sm font-medium text-primary">Social Campaigns</p>
            <h1 className="text-xl font-semibold tracking-tight">
              {step === 1 ? "Create Social Post" : name || "Untitled campaign"}
            </h1>
          </div>
        </div>
        {step === 2 ? (
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={saveDraft} disabled={!canProceed}>
              Save Draft
            </Button>
            <Button onClick={publishNow} disabled={!canProceed}>
              <Send className="size-4" />
              Save and Proceed
            </Button>
          </div>
        ) : null}
      </div>

      {/* Body */}
      {step === 1 ? (
        <div className="grid flex-1 gap-0 p-6 lg:grid-cols-[minmax(0,360px)_1fr]">
          {/* Left info panel */}
          <div className="hidden flex-col items-center justify-center gap-4 rounded-l-xl bg-muted/40 p-8 text-center lg:flex">
            <div className="flex size-20 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Megaphone className="size-9" />
            </div>
            <h2 className="text-lg font-semibold">General Details</h2>
            <p className="max-w-xs text-sm leading-relaxed text-muted-foreground text-pretty">
              General information about your campaign gives an overview of its purpose. Give it a name
              and pick the brand to proceed.
            </p>
          </div>

          {/* Form */}
          <Card className="rounded-xl lg:rounded-l-none">
            <CardContent className="flex flex-col gap-6 pt-6">
              <div className="space-y-2">
                <Label htmlFor="wiz-name">Name</Label>
                <Input
                  id="wiz-name"
                  placeholder="Enter your campaign name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  aria-invalid={nameTouched && !nameValid}
                />
                {nameTouched && !nameValid ? (
                  <p className="text-xs text-destructive">Enter a campaign name</p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label>Choose Brand</Label>
                <Select value={brand} onValueChange={setBrand}>
                  <SelectTrigger aria-label="Choose brand">
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {BRANDS.map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    setNameTouched(true)
                    if (nameValid) setStep(2)
                  }}
                >
                  Next
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="flex-1 p-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Social Content</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Account selector */}
              {accounts.length === 0 ? (
                <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  No accounts connected yet. Connect one from the Connected Accounts tab to publish.
                </p>
              ) : (
                <div className="space-y-2">
                  <Label>Post to</Label>
                  <div className="flex flex-wrap gap-3">
                    {accounts.map((account) => {
                      const active = selectedAccounts.includes(account.id)
                      return (
                        <button
                          key={account.id}
                          type="button"
                          onClick={() => toggleAccount(account.id)}
                          title={`${account.handle}${account.owner ? ` · ${account.owner}` : ""}`}
                          className={cn(
                            "flex flex-col items-center gap-1.5 rounded-lg border p-2 transition-colors",
                            active
                              ? "border-primary bg-primary/10"
                              : "border-transparent opacity-60 hover:opacity-100",
                          )}
                        >
                          <AccountAvatar account={account} />
                          <span className="max-w-16 truncate text-[11px] text-muted-foreground">
                            {account.owner ?? account.handle}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Content editor */}
              <div className="space-y-2 rounded-lg border">
                <Textarea
                  rows={7}
                  placeholder="Write your post content here..."
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="resize-none border-0 focus-visible:ring-0"
                />

                {image ? (
                  <div className="relative mx-3 w-fit">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={image || "/placeholder.svg"}
                      alt="Post attachment preview"
                      className="max-h-48 rounded-md border object-cover"
                    />
                    <Button
                      variant="secondary"
                      size="icon-sm"
                      className="absolute -top-2 -right-2 rounded-full"
                      onClick={() => setImage(undefined)}
                      aria-label="Remove image"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ) : null}

                <div className="relative flex items-center gap-1 border-t px-3 py-2">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Add emoji"
                    onClick={() => setShowEmoji((v) => !v)}
                  >
                    <Smile className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Upload image"
                    onClick={() => fileRef.current?.click()}
                  >
                    <ImageUp className="size-4" />
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleFile}
                  />
                  {activeLimit !== null ? (
                    <span
                      className={cn(
                        "ml-auto text-xs",
                        overLimit ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {content.length}/{activeLimit}
                    </span>
                  ) : null}

                  {showEmoji ? (
                    <div className="absolute bottom-11 left-0 z-10 grid grid-cols-8 gap-1 rounded-lg border bg-popover p-2 shadow-md">
                      {EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="rounded p-1 text-lg hover:bg-muted"
                          onClick={() => {
                            setContent((c) => c + emoji)
                            setShowEmoji(false)
                          }}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>

              {overLimit ? (
                <p className="text-xs text-destructive">
                  Content exceeds the limit for the tightest selected platform.
                </p>
              ) : (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Sparkles className="size-3" />
                  Select the accounts you want to publish to, then write your content.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
