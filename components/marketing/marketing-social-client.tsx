"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
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
  ExternalLink,
  AlertTriangle,
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
import { fetcher } from "@/lib/fetcher"
import { SOCIAL_PLATFORMS, getSocialPlatform, type SocialPlatformId } from "@/lib/social-platforms"

/* ------------------------------------------------------------------ */
/* Types (mirror the API shapes)                                       */
/* ------------------------------------------------------------------ */

type AccountType = "company" | "personal"

type Account = {
  id: number
  platform: SocialPlatformId
  type: AccountType
  handle: string
  displayName: string | null
  owner: string | null
  followers: number | null
  connectedAt: string
}

type PostStatus = "Draft" | "Scheduled" | "Publishing" | "Published" | "Failed"

type PublishResult = {
  accountId: number
  platform: string
  handle: string
  ok: boolean
  permalink?: string
  error?: string
}

type SocialPost = {
  id: number
  name: string
  content: string
  brand: string | null
  image?: string
  targets: SocialPlatformId[]
  accountIds: number[]
  status: PostStatus
  folder: string
  results: PublishResult[] | null
  createdAt: string
  publishedAt: string | null
}

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

function PlatformBadge({ id, size = "sm" }: { id: SocialPlatformId; size?: "sm" | "md" }) {
  const p = getSocialPlatform(id)
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
  return new Date(iso.replace(" ", "T")).toLocaleString(undefined, {
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
  const {
    data: accountsData,
    isLoading: accountsLoading,
    mutate: mutateAccounts,
  } = useSWR<{ accounts: Account[]; configured: Record<string, boolean> }>(
    "/api/marketing/social/accounts",
    fetcher,
  )
  const { data: postsData, mutate: mutatePosts } = useSWR<{ posts: SocialPost[] }>(
    "/api/marketing/social/posts",
    fetcher,
  )

  const accounts = accountsData?.accounts ?? []
  const configured = accountsData?.configured ?? {}
  const posts = postsData?.posts ?? []

  const [folder, setFolder] = React.useState("all")
  const [statusFilter, setStatusFilter] = React.useState("all")
  const [query, setQuery] = React.useState("")
  const [composing, setComposing] = React.useState(false)

  // Surface the OAuth redirect result (?social=...) as a toast, then clean the URL.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get("social")
    if (!status) return
    const platform = params.get("platform")
    const detail = params.get("detail")
    const platformName = platform ? getSocialPlatform(platform as SocialPlatformId)?.name ?? platform : "account"
    const withDetail = (base: string) => (detail ? `${base} (${detail})` : base)
    if (status === "connected") toast.success(`${platformName} account connected`)
    else if (status === "notconfigured")
      toast.error(`${platformName} is not configured yet. Add its developer app credentials to connect.`)
    else if (status === "noadmin")
      toast.error("No LinkedIn company page found where you are an administrator.")
    else if (status === "noorgscope")
      toast.error(
        "LinkedIn company posting requires organization access that isn't enabled on this app. Connect a personal LinkedIn profile instead.",
      )
    else if (status === "nopage") toast.error("No Facebook Page found on this account.")
    else if (status === "noig")
      toast.error("No Instagram professional (Business/Creator) account was found for this login.")
    else if (status === "tokenfail")
      toast.error(withDetail(`${platformName} connection failed: token exchange rejected`))
    else if (status === "profilefail")
      toast.error(withDetail(`${platformName} connection failed: could not load your profile`))
    else if (status === "dbsave")
      toast.error(withDetail(`${platformName} connection failed: could not save the account`))
    else toast.error(`Could not connect your ${platformName} account`)
    params.delete("social")
    params.delete("platform")
    params.delete("detail")
    const qs = params.toString()
    window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""))
    mutateAccounts()
  }, [mutateAccounts])

  const folders = React.useMemo(() => Array.from(new Set(posts.map((p) => p.folder))), [posts])

  const filtered = posts.filter((p) => {
    const byFolder = folder === "all" || p.folder === folder
    const byStatus = statusFilter === "all" || p.status === statusFilter
    const byQuery = p.name.toLowerCase().includes(query.toLowerCase())
    return byFolder && byStatus && byQuery
  })

  /* ---- account actions ---- */
  function connect(platform: SocialPlatformId, type: AccountType) {
    window.location.href = `/api/marketing/social/connect?platform=${platform}&type=${type}`
  }
  async function disconnect(id: number) {
    await fetch(`/api/marketing/social/accounts/${id}`, { method: "DELETE" })
    toast.success("Account disconnected")
    mutateAccounts()
  }

  /* ---- post actions ---- */
  async function clonePost(post: SocialPost) {
    await fetch("/api/marketing/social/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `${post.name} (copy)`,
        content: post.content,
        brand: post.brand,
        image: post.image,
        targets: post.targets,
        accountIds: post.accountIds,
        status: "Draft",
        folder: post.folder,
      }),
    })
    toast.success("Post cloned as draft")
    mutatePosts()
  }
  async function deletePost(id: number) {
    await fetch(`/api/marketing/social/posts/${id}`, { method: "DELETE" })
    toast.success("Post deleted")
    mutatePosts()
  }

  async function publishPost(id: number) {
    mutatePosts(
      (cur) =>
        cur ? { posts: cur.posts.map((p) => (p.id === id ? { ...p, status: "Publishing" } : p)) } : cur,
      false,
    )
    try {
      const res = await fetch("/api/marketing/social/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId: id }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Publish failed")
      const results: PublishResult[] = json.results ?? []
      const okCount = results.filter((r) => r.ok).length
      const failCount = results.length - okCount
      if (failCount === 0) toast.success(`Published live to ${okCount} account${okCount === 1 ? "" : "s"}`)
      else if (okCount === 0)
        toast.error(`Publish failed: ${results.find((r) => !r.ok)?.error ?? "unknown error"}`)
      else toast.warning(`Published to ${okCount}, ${failCount} failed`)
    } catch (err: any) {
      toast.error(err?.message || "Publish failed")
    } finally {
      mutatePosts()
    }
  }

  const publishedCount = posts.filter((p) => p.status === "Published").length
  const knownFollowers = accounts.filter((a) => typeof a.followers === "number")
  const totalReach = knownFollowers.reduce((s, a) => s + (a.followers ?? 0), 0)

  if (composing) {
    return (
      <ComposeWizard
        accounts={accounts}
        onCancel={() => setComposing(false)}
        onCreated={() => mutatePosts()}
        onPublish={publishPost}
      />
    )
  }

  return (
    <div className="space-y-6 p-6">
      <MarketingHeader
        eyebrow="Marketing Campaigns"
        title="Social Campaigns"
        description="Connect your real social accounts and publish posts straight to every connected platform from one place."
        action={
          <Button onClick={() => setComposing(true)} disabled={accounts.length === 0}>
            <Plus className="size-4" />
            Create
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Connected Accounts"
          value={accounts.length}
          icon={LinkIcon}
          hint={`${SOCIAL_PLATFORMS.length} platforms available`}
        />
        <StatCard
          label="Total Reach"
          value={knownFollowers.length ? formatCount(totalReach) : "—"}
          icon={Users}
          hint="Across connected networks"
        />
        <StatCard
          label="Posts"
          value={posts.length}
          icon={FileText}
          hint={`${posts.filter((p) => p.status === "Draft").length} drafts`}
        />
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
                  <Select value={folder} onValueChange={(v) => setFolder(v ?? "all")}>
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
                  <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
                    <SelectTrigger className="h-9 w-32" aria-label="Filter by status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="Draft">Draft</SelectItem>
                      <SelectItem value="Published">Published</SelectItem>
                      <SelectItem value="Failed">Failed</SelectItem>
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
                  <p className="text-sm text-muted-foreground">
                    {posts.length === 0
                      ? "No campaigns yet. Connect an account and create your first post."
                      : "No campaigns match your filters."}
                  </p>
                </div>
              ) : (
                filtered.map((post) => (
                  <PostRow
                    key={post.id}
                    post={post}
                    onClone={() => clonePost(post)}
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
            post under their name. Connecting opens the platform&apos;s secure sign-in — we never see your
            password.
          </p>
          {accountsLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {SOCIAL_PLATFORMS.map((p) => {
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
                        ) : configured[p.id] ? null : (
                          <Badge variant="outline" className="gap-1 text-amber-600">
                            <AlertTriangle className="size-3" />
                            Setup
                          </Badge>
                        )}
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
                                  {typeof account.followers === "number"
                                    ? `${formatCount(account.followers)} followers`
                                    : "Connected"}
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

                      <ConnectDialog
                        platform={p}
                        configured={Boolean(configured[p.id])}
                        hasAccounts={list.length > 0}
                        onConnect={connect}
                      />
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
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
  const permalinks = (post.results ?? []).filter((r) => r.ok && r.permalink)
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
        {permalinks.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            {permalinks.map((r) => (
              <a
                key={r.accountId}
                href={r.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <ExternalLink className="size-3" />
                {r.handle}
              </a>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Badge className={cn("gap-1", STATUS_STYLES[post.status])}>
          {post.status === "Publishing" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : post.status === "Published" ? (
            <CheckCircle2 className="size-3" />
          ) : post.status === "Scheduled" ? (
            <CalendarClock className="size-3" />
          ) : post.status === "Failed" ? (
            <AlertTriangle className="size-3" />
          ) : (
            <FileText className="size-3" />
          )}
          {post.status}
        </Badge>

        {canPublish ? (
          <Button size="sm" onClick={onPublish} disabled={post.accountIds.length === 0}>
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
  configured,
  hasAccounts,
  onConnect,
}: {
  platform: (typeof SOCIAL_PLATFORMS)[number]
  configured: boolean
  hasAccounts: boolean
  onConnect: (platform: SocialPlatformId, type: AccountType) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [type, setType] = React.useState<AccountType>("company")

  // Facebook & Instagram publishing is always page/business based.
  const pageOnly = platform.id === "facebook" || platform.id === "instagram"

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
              <DialogDescription>
                You&apos;ll be redirected to {platform.name} to authorize this ERP.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!configured ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="space-y-1">
                <p className="font-medium">Developer credentials required</p>
                <p className="text-muted-foreground">{platform.setupHint}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Once you have them, add the credentials as project environment variables and this button
              will connect a live account.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {pageOnly ? (
              <p className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                {platform.name} publishes through a{" "}
                {platform.id === "instagram" ? "linked Instagram Business account" : "Facebook Page"} you
                administer. We&apos;ll connect the first one available.
              </p>
            ) : (
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
                <p className="text-xs text-muted-foreground">
                  {type === "company"
                    ? "Publish as the brand from a page you administer."
                    : "Publish under your own name from your personal account."}
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          {configured ? (
            <Button onClick={() => onConnect(platform.id, pageOnly ? "company" : type)}>
              <LinkIcon className="size-4" />
              Continue to {platform.name}
            </Button>
          ) : null}
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
  const p = getSocialPlatform(account.platform)
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
  onCreated,
  onPublish,
}: {
  accounts: Account[]
  onCancel: () => void
  onCreated: () => void
  onPublish: (id: number) => void
}) {
  const [step, setStep] = React.useState<1 | 2>(1)

  // step 1
  const [name, setName] = React.useState("")
  const [brand, setBrand] = React.useState("")
  const [nameTouched, setNameTouched] = React.useState(false)

  // step 2
  const [selectedAccounts, setSelectedAccounts] = React.useState<number[]>([])
  const [content, setContent] = React.useState("")
  const [image, setImage] = React.useState<string | undefined>(undefined)
  const [showEmoji, setShowEmoji] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)

  const nameValid = name.trim().length > 0

  const toggleAccount = (id: number) =>
    setSelectedAccounts((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]))

  const chosen = accounts.filter((a) => selectedAccounts.includes(a.id))
  const targets = Array.from(new Set(chosen.map((a) => a.platform)))
  const activeLimit = targets.length ? Math.min(...targets.map((t) => getSocialPlatform(t).limit)) : null
  const overLimit = activeLimit !== null && content.length > activeLimit
  const needsImage = targets.includes("instagram") && !image

  const canProceed = selectedAccounts.length > 0 && content.trim().length > 0 && !overLimit && !needsImage

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setImage(reader.result as string)
    reader.readAsDataURL(file)
  }

  async function createPost(status: "Draft" | "Publishing"): Promise<number | null> {
    const res = await fetch("/api/marketing/social/posts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        content: content.trim(),
        brand: brand || null,
        image,
        targets,
        accountIds: selectedAccounts,
        status,
        folder: "Unclassified",
      }),
    })
    const json = await res.json()
    if (!res.ok) {
      toast.error(json.error || "Could not save post")
      return null
    }
    return json.id as number
  }

  async function saveDraft() {
    setSubmitting(true)
    const id = await createPost("Draft")
    setSubmitting(false)
    if (id == null) return
    toast.success("Draft saved")
    onCreated()
    onCancel()
  }

  async function publishNow() {
    setSubmitting(true)
    const id = await createPost("Publishing")
    if (id == null) {
      setSubmitting(false)
      return
    }
    onCreated()
    onCancel()
    onPublish(id)
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
            <Button variant="outline" onClick={saveDraft} disabled={!canProceed || submitting}>
              Save Draft
            </Button>
            <Button onClick={publishNow} disabled={!canProceed || submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Publish Live
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
              and an optional brand label to proceed.
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
                <Label htmlFor="wiz-brand">Brand label (optional)</Label>
                <Input
                  id="wiz-brand"
                  placeholder="e.g. your brand or product name"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                />
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
              ) : needsImage ? (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle className="size-3" />
                  Instagram requires an image. Attach one to publish to Instagram.
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
