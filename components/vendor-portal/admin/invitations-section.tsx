"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Send, Inbox, Mail, RefreshCw, XCircle, Clock, Copy, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { SectionHeader, StatusBadge, EmptyState, AdminTable, type Column } from "./shared"
import { INVITATIONS, ACCESS_REQUESTS, ACCESS_REQUEST_STATUS_LABEL } from "./mock-data"

const INVITE_COLUMNS: Column[] = [
  { key: "vendor", header: "Vendor" },
  { key: "recipient", header: "Recipient" },
  { key: "role", header: "Role" },
  { key: "sent", header: "Sent" },
  { key: "expires", header: "Expires" },
  { key: "accepted", header: "Accepted" },
  { key: "status", header: "Status" },
  { key: "sentBy", header: "Sent By" },
  { key: "actions", header: "" },
]

const REQUEST_COLUMNS: Column[] = [
  { key: "id", header: "Request" },
  { key: "vendor", header: "Vendor" },
  { key: "user", header: "User" },
  { key: "type", header: "Type" },
  { key: "requested", header: "Requested" },
  { key: "status", header: "Status" },
  { key: "actions", header: "" },
]

export function InvitationsSection() {
  const [tab, setTab] = useState("invitations")

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Invitations & Access Requests"
        description="Track vendor invitations and triage the central queue of access requests raised from the portal."
        icon={Send}
        actions={
          <Button size="sm" onClick={() => toast.success("Invitation composer opened")}>
            <Mail className="size-4" /> New Invitation
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="invitations">
            <Send className="size-4" /> Invitations
          </TabsTrigger>
          <TabsTrigger value="requests">
            <Inbox className="size-4" /> Access Requests
          </TabsTrigger>
        </TabsList>

        <TabsContent value="invitations">
          <AdminTable
            columns={INVITE_COLUMNS}
            rows={INVITATIONS}
            empty={<EmptyState icon={Send} title="No invitations" />}
            render={(inv, key) => {
              switch (key) {
                case "vendor":
                  return <span className="font-medium">{inv.vendor}</span>
                case "recipient":
                  return (
                    <div className="grid">
                      <span>{inv.recipient}</span>
                      <span className="text-xs text-muted-foreground">{inv.email}</span>
                    </div>
                  )
                case "role":
                  return inv.role
                case "sent":
                  return <span className="text-muted-foreground">{inv.sent}</span>
                case "expires":
                  return <span className="text-muted-foreground">{inv.expires}</span>
                case "accepted":
                  return <span className="text-muted-foreground">{inv.accepted ?? "—"}</span>
                case "status":
                  return <StatusBadge status={inv.status === "sent" ? "invited" : inv.status} label={inv.status} />
                case "sentBy":
                  return <span className="text-muted-foreground">{inv.sentBy}</span>
                case "actions":
                  return (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Invitation resent")}>
                        <RefreshCw className="size-3.5" /> Resend
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Expiry extended")}>
                        <Clock className="size-3.5" /> Extend
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Link copied")}>
                        <Copy className="size-3.5" /> Copy
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Invitation revoked")}>
                        <XCircle className="size-3.5" /> Revoke
                      </Button>
                    </div>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>

        <TabsContent value="requests">
          <AdminTable
            columns={REQUEST_COLUMNS}
            rows={ACCESS_REQUESTS}
            empty={<EmptyState icon={Inbox} title="No access requests" />}
            render={(r, key) => {
              switch (key) {
                case "id":
                  return <span className="font-mono text-xs">{r.id}</span>
                case "vendor":
                  return <span className="font-medium">{r.vendor}</span>
                case "user":
                  return <span className="text-muted-foreground">{r.user}</span>
                case "type":
                  return r.type
                case "requested":
                  return <span className="text-muted-foreground">{r.requested}</span>
                case "status":
                  return <StatusBadge status={r.status} label={ACCESS_REQUEST_STATUS_LABEL[r.status]} />
                case "actions":
                  return (
                    <div className="flex justify-end gap-1">
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Request approved")}>
                        <CheckCircle2 className="size-3.5" /> Approve
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => toast.success("Request rejected")}>
                        <XCircle className="size-3.5" /> Reject
                      </Button>
                    </div>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
