"use client"

import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Mail,
  Phone,
  Building2,
  MapPin,
  Pencil,
  UserRound,
  Clock,
  Tag as TagIcon,
  Link2,
} from "lucide-react"

function initials(name: string) {
  return (
    name
      ?.split(" ")
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?"
  )
}

function timeAgo(value: string) {
  const d = new Date(value)
  const diff = Date.now() - d.getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days}d ago`
  return d.toLocaleDateString()
}

const SUB_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Subscribed: "default",
  Unsubscribed: "outline",
  Pending: "secondary",
}

export function ContactDrawer({
  contactId,
  open,
  onOpenChange,
  onEdit,
}: {
  contactId: number | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onEdit: (contact: any) => void
}) {
  const { data } = useSWR<any>(open && contactId ? `/api/marketing/contacts/${contactId}` : null, fetcher)
  const { data: activityData } = useSWR<any>(
    open && contactId ? `/api/marketing/contacts/${contactId}/activity` : null,
    fetcher,
  )
  const contact = data?.contact
  const activity: any[] = activityData?.activity || []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-lg">
        {!contact ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <SheetHeader className="space-y-0 border-b p-6">
              <div className="flex items-start gap-4">
                <Avatar className="size-12">
                  <AvatarFallback>{initials(contact.full_name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="truncate text-lg">{contact.full_name}</SheetTitle>
                  <SheetDescription className="truncate">
                    {contact.job_title ? `${contact.job_title}` : "Contact"}
                    {contact.company_name ? ` · ${contact.company_name}` : ""}
                  </SheetDescription>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {contact.contact_code}
                    </Badge>
                    <Badge variant={SUB_VARIANT[contact.email_subscription] || "outline"}>
                      {contact.email_subscription}
                    </Badge>
                    <Badge variant="secondary">{contact.lifecycle_stage}</Badge>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => onEdit(contact)}>
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
              </div>
            </SheetHeader>

            <Tabs defaultValue="overview" className="flex-1">
              <TabsList className="mx-6 mt-4">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-5 p-6 pt-4">
                <div className="space-y-3">
                  <Row icon={Mail} label="Email" value={contact.email} />
                  <Row icon={Phone} label="Phone" value={contact.phone} />
                  <Row icon={Building2} label="Company" value={contact.company_name} />
                  <Row
                    icon={MapPin}
                    label="Location"
                    value={[contact.city, contact.state, contact.country].filter(Boolean).join(", ")}
                  />
                  <Row icon={UserRound} label="Owner" value={contact.owner_name} />
                </div>

                {(contact.linked_client_code || contact.linked_lead_code) && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <Link2 className="size-3.5" /> Linked records
                      </p>
                      {contact.linked_client_code && (
                        <Badge variant="outline">Client · {contact.linked_client_code}</Badge>
                      )}
                      {contact.linked_lead_code && (
                        <Badge variant="outline">Lead · {contact.linked_lead_code}</Badge>
                      )}
                    </div>
                  </>
                )}

                {contact.tags?.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <TagIcon className="size-3.5" /> Tags
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {contact.tags.map((t: string) => (
                          <Badge key={t} variant="secondary">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {contact.notes && (
                  <>
                    <Separator />
                    <div className="space-y-1.5">
                      <p className="text-xs font-medium text-muted-foreground">Notes</p>
                      <p className="whitespace-pre-wrap text-sm text-pretty">{contact.notes}</p>
                    </div>
                  </>
                )}
              </TabsContent>

              <TabsContent value="activity" className="p-6 pt-4">
                {activity.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
                ) : (
                  <ol className="space-y-4">
                    {activity.map((a) => (
                      <li key={a.id} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span className="mt-1 size-2 rounded-full bg-primary" />
                          <span className="w-px flex-1 bg-border" />
                        </div>
                        <div className="flex-1 pb-1">
                          <p className="text-sm">{a.summary}</p>
                          <p className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Clock className="size-3" />
                            {timeAgo(a.created_at)}
                            {a.actor_name ? ` · ${a.actor_name}` : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: string | null
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm">{value || "—"}</p>
      </div>
    </div>
  )
}
