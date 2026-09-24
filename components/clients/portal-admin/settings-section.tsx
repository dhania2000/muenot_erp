"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SectionHeader } from "./shared"
import { PORTAL_TOGGLES } from "./data"

function SettingsCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-4">{children}</div>
    </div>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="flex items-start justify-between gap-4">
      <span>
        <span className="text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

export function SettingsSection() {
  const [toggles, setToggles] = useState(PORTAL_TOGGLES)

  function set(key: string, value: boolean) {
    setToggles((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Portal Settings"
        description="Global configuration for the client portal — branding, access policy, security and integrations."
        actions={
          <Button size="sm" onClick={() => toast.success("Portal settings saved")}>Save all changes</Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SettingsCard title="Branding" description="How the portal appears to your clients.">
          <div className="grid gap-2">
            <Label htmlFor="pt-name">Portal name</Label>
            <Input id="pt-name" defaultValue="Muenot Client Portal" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pt-url">Portal URL</Label>
            <Input id="pt-url" defaultValue="portal.muenot.com" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pt-welcome">Welcome message</Label>
            <Textarea id="pt-welcome" rows={3} defaultValue="Welcome to your client portal. Access your projects, invoices and documents in one place." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="pt-primary">Primary colour</Label>
              <Input id="pt-primary" type="color" defaultValue="#6d28d9" className="h-9 p-1" />
            </div>
            <div className="grid gap-2">
              <Label>Default language</Label>
              <Select defaultValue="en">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="hi">Hindi</SelectItem>
                  <SelectItem value="ar">Arabic</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard title="Access policy" description="Control how clients gain access to the portal.">
          <ToggleRow
            label="Allow self-registration"
            description="Clients can request access via the public onboarding form."
            checked={toggles.selfRegistration}
            onChange={(v) => set("selfRegistration", v)}
          />
          <ToggleRow
            label="Require manual approval"
            description="New registrations must be approved before activation."
            checked={toggles.manualApproval}
            onChange={(v) => set("manualApproval", v)}
          />
          <ToggleRow
            label="Auto-provision client record"
            description="Create a linked client record automatically on approval."
            checked={toggles.autoProvision}
            onChange={(v) => set("autoProvision", v)}
          />
          <div className="grid gap-2">
            <Label>Invitation expiry</Label>
            <Select defaultValue="7">
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3">3 days</SelectItem>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SettingsCard>

        <SettingsCard title="Security" description="Protect portal accounts and data.">
          <ToggleRow
            label="Require two-factor authentication"
            description="Portal users must set up 2FA on first login."
            checked={toggles.require2fa}
            onChange={(v) => set("require2fa", v)}
          />
          <ToggleRow
            label="Restrict by IP allowlist"
            description="Only permit portal access from approved IP ranges."
            checked={toggles.ipAllowlist}
            onChange={(v) => set("ipAllowlist", v)}
          />
          <ToggleRow
            label="Watermark shared documents"
            description="Apply a client watermark to downloaded documents."
            checked={toggles.watermark}
            onChange={(v) => set("watermark", v)}
          />
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Session timeout</Label>
              <Select defaultValue="30">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="30">30 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="480">8 hours</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Password policy</Label>
              <Select defaultValue="strong">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="standard">Standard</SelectItem>
                  <SelectItem value="strong">Strong</SelectItem>
                  <SelectItem value="strict">Strict</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </SettingsCard>

        <SettingsCard title="Features & modules" description="Toggle which portal areas clients can use.">
          <ToggleRow
            label="Invoices & payments"
            description="Let clients view invoices and pay online."
            checked={toggles.moduleInvoices}
            onChange={(v) => set("moduleInvoices", v)}
          />
          <ToggleRow
            label="Projects & tasks"
            description="Show project progress and shared tasks."
            checked={toggles.moduleProjects}
            onChange={(v) => set("moduleProjects", v)}
          />
          <ToggleRow
            label="Support tickets"
            description="Allow clients to raise and track tickets."
            checked={toggles.moduleSupport}
            onChange={(v) => set("moduleSupport", v)}
          />
          <ToggleRow
            label="Knowledge base"
            description="Publish help articles and FAQs to the portal."
            checked={toggles.moduleKnowledge}
            onChange={(v) => set("moduleKnowledge", v)}
          />
        </SettingsCard>
      </div>
    </div>
  )
}
