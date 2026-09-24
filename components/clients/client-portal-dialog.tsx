"use client"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ShieldCheck } from "lucide-react"
import { ClientPortalControls } from "@/components/clients/client-portal-controls"
import type { ClientRow } from "@/components/clients/clients-client"

export function ClientPortalDialog({
  client,
  open,
  onOpenChange,
}: {
  client: ClientRow | null
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" /> Portal access
          </DialogTitle>
          <DialogDescription>
            Control what {client?.company_name || client?.client_name} can see and do in the client portal, and manage
            their login accounts.
          </DialogDescription>
        </DialogHeader>

        <ClientPortalControls client={client} active={open} />
      </DialogContent>
    </Dialog>
  )
}
