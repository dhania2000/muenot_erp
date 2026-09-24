"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  Settings2,
  Globe,
  Palette,
  Bell,
  Wallet,
  ShieldCheck,
  FileText,
  Wrench,
  Upload,
  Link2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { SectionHeader } from "./shared"

const BRAND_COLORS = [
  { label: "Primary", value: "#4f46e5" },
  { label: "Accent", value: "#0ea5e9" },
  { label: "Background", value: "#ffffff" },
  { label: "Text", value: "#0f172a" },
]

function ToggleRow({ label, desc, on = true }: { label: string; desc: string; on?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="grid gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </div>
      <Switch defaultChecked={on} onCheckedChange={() => toast.success("Setting updated")} />
    </div>
  )
}

function Fld({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

export function SettingsSection() {
  const [logo, setLogo] = useState<string | null>(null)

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Portal Settings"
        description="Configure global vendor portal behavior — branding, registration, finance, security, notifications and advanced options."
        icon={Settings2}
        actions={
          <Button size="sm" onClick={() => toast.success("All settings saved")}>
            Save changes
          </Button>
        }
      />

      <Tabs defaultValue="general" className="gap-4">
        <div className="-mx-1 overflow-x-auto pb-1">
          <TabsList variant="line" className="w-max">
            <TabsTrigger value="general">
              <Globe className="size-4" /> General
            </TabsTrigger>
            <TabsTrigger value="branding">
              <Palette className="size-4" /> Branding
            </TabsTrigger>
            <TabsTrigger value="registration">
              <FileText className="size-4" /> Registration
            </TabsTrigger>
            <TabsTrigger value="finance">
              <Wallet className="size-4" /> Finance
            </TabsTrigger>
            <TabsTrigger value="security">
              <ShieldCheck className="size-4" /> Security
            </TabsTrigger>
            <TabsTrigger value="notifications">
              <Bell className="size-4" /> Notifications
            </TabsTrigger>
            <TabsTrigger value="advanced">
              <Wrench className="size-4" /> Advanced
            </TabsTrigger>
          </TabsList>
        </div>

        {/* General */}
        <TabsContent value="general" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Portal identity</CardTitle>
              <CardDescription>Basic details vendors see across the portal</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Fld label="Portal name">
                <Input defaultValue="Muenot Vendor Portal" />
              </Fld>
              <Fld label="Support email">
                <Input defaultValue="vendors@muenot.com" type="email" />
              </Fld>
              <Fld label="Default language">
                <Select defaultValue="en">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="hi">Hindi</SelectItem>
                    <SelectItem value="de">German</SelectItem>
                  </SelectContent>
                </Select>
              </Fld>
              <Fld label="Default timezone">
                <Select defaultValue="ist">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ist">Asia/Kolkata (IST)</SelectItem>
                    <SelectItem value="cet">Europe/Berlin (CET)</SelectItem>
                    <SelectItem value="utc">UTC</SelectItem>
                  </SelectContent>
                </Select>
              </Fld>
              <Fld label="Default currency">
                <Select defaultValue="inr">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inr">INR — Indian Rupee</SelectItem>
                    <SelectItem value="eur">EUR — Euro</SelectItem>
                    <SelectItem value="usd">USD — US Dollar</SelectItem>
                  </SelectContent>
                </Select>
              </Fld>
              <Fld label="Date format">
                <Select defaultValue="dmy">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dmy">DD/MM/YYYY</SelectItem>
                    <SelectItem value="mdy">MM/DD/YYYY</SelectItem>
                    <SelectItem value="ymd">YYYY-MM-DD</SelectItem>
                  </SelectContent>
                </Select>
              </Fld>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Availability</CardTitle>
              <CardDescription>Control access to the portal</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <ToggleRow label="Portal enabled" desc="Allow vendors to log in and use the portal" />
              <ToggleRow label="Maintenance mode" desc="Temporarily block vendor logins with a notice" on={false} />
              <ToggleRow label="Show system status banner" desc="Display planned maintenance announcements" />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Branding */}
        <TabsContent value="branding" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Logo & favicon</CardTitle>
              <CardDescription>Upload brand assets shown on the vendor login and portal</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label className="text-xs">Portal logo</Label>
                <div className="flex items-center gap-3">
                  <div className="flex size-16 items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 text-xs text-muted-foreground">
                    {logo ? "Logo" : "160×48"}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => { setLogo("uploaded"); toast.success("Logo uploaded") }}>
                    <Upload className="size-4" /> Upload
                  </Button>
                </div>
              </div>
              <div className="grid gap-2">
                <Label className="text-xs">Favicon</Label>
                <div className="flex items-center gap-3">
                  <div className="flex size-16 items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 text-xs text-muted-foreground">
                    32×32
                  </div>
                  <Button size="sm" variant="outline" onClick={() => toast.success("Favicon uploaded")}>
                    <Upload className="size-4" /> Upload
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Theme colors</CardTitle>
              <CardDescription>Match the portal to your corporate palette</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {BRAND_COLORS.map((c) => (
                <div key={c.label} className="grid gap-1.5">
                  <Label className="text-xs">{c.label}</Label>
                  <div className="flex items-center gap-2">
                    <span
                      className="size-8 shrink-0 rounded-md border border-border"
                      style={{ backgroundColor: c.value }}
                      aria-hidden
                    />
                    <Input defaultValue={c.value} className="font-mono text-xs" />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Login page & footer</CardTitle>
              <CardDescription>Custom copy shown to vendors</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Fld label="Login welcome heading">
                <Input defaultValue="Welcome to the Muenot Vendor Portal" />
              </Fld>
              <Fld label="Login sub-text">
                <Textarea rows={2} defaultValue="Submit invoices, track payments and manage your company profile in one place." />
              </Fld>
              <Fld label="Footer text">
                <Input defaultValue="© 2026 Muenot Industries. All rights reserved." />
              </Fld>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Registration */}
        <TabsContent value="registration" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Self-registration</CardTitle>
              <CardDescription>How prospective vendors sign up</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <ToggleRow label="Enable public registration" desc="Show a registration link on the login page" />
              <ToggleRow label="Require invitation code" desc="Only invited vendors can register" on={false} />
              <ToggleRow label="Approve automatically" desc="Skip manual review for trusted domains" on={false} />
              <ToggleRow label="Collect W-9 / tax forms" desc="Require tax documentation at registration" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Registration link</CardTitle>
              <CardDescription>Share this with prospective vendors</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <Input readOnly defaultValue="https://portal.muenot.com/register" className="max-w-md font-mono text-xs" />
              <Button size="sm" variant="outline" onClick={() => toast.success("Link copied")}>
                <Link2 className="size-4" /> Copy link
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Finance */}
        <TabsContent value="finance" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Invoice submission</CardTitle>
              <CardDescription>Rules for vendor-submitted invoices</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <ToggleRow label="Allow invoice submission" desc="Vendors can upload invoices against POs" />
              <ToggleRow label="Require matching PO" desc="Block invoices without a valid purchase order" />
              <ToggleRow label="Auto-validate GST/tax" desc="Check tax numbers before accepting invoices" />
              <ToggleRow label="Show payment status" desc="Let vendors track payment progress in the portal" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Visibility defaults</CardTitle>
              <CardDescription>What vendors see by default in the portal</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <ToggleRow label="Publish purchase orders" desc="Automatically share new POs with the vendor" />
              <ToggleRow label="Publish payment advice" desc="Share remittance advice when payments complete" />
              <ToggleRow label="Publish contracts" desc="Share signed contracts to the vendor workspace" on={false} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security */}
        <TabsContent value="security" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Authentication</CardTitle>
              <CardDescription>Portal-wide login protection</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <ToggleRow label="Require MFA" desc="Enforce multi-factor authentication for all users" />
              <ToggleRow label="Restrict to trusted domains" desc="Only allow logins from approved email domains" on={false} />
              <ToggleRow label="Enforce account lockout" desc="Lock accounts after repeated failed logins" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Thresholds</CardTitle>
              <CardDescription>Session and lockout limits</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Fld label="Failed login threshold">
                <Input defaultValue="5" />
              </Fld>
              <Fld label="Session timeout (min)">
                <Input defaultValue="30" />
              </Fld>
              <Fld label="Concurrent sessions">
                <Input defaultValue="3" />
              </Fld>
              <Fld label="Password expiry (days)">
                <Input defaultValue="90" />
              </Fld>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Notifications */}
        <TabsContent value="notifications" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Channels</CardTitle>
              <CardDescription>Enable delivery channels for vendor notifications</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <ToggleRow label="Email" desc="Transactional emails for portal events" />
              <ToggleRow label="In-portal notifications" desc="Bell notifications inside the portal" />
              <ToggleRow label="SMS" desc="Text alerts for critical events" on={false} />
              <ToggleRow label="WhatsApp" desc="WhatsApp Business alerts for payments" on={false} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Sender configuration</CardTitle>
              <CardDescription>How notifications are addressed</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Fld label="From name">
                <Input defaultValue="Muenot Procurement" />
              </Fld>
              <Fld label="From email">
                <Input defaultValue="no-reply@muenot.com" type="email" />
              </Fld>
              <Fld label="Reply-to email">
                <Input defaultValue="vendors@muenot.com" type="email" />
              </Fld>
              <Fld label="Digest frequency">
                <Select defaultValue="daily">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="realtime">Real-time</SelectItem>
                    <SelectItem value="daily">Daily digest</SelectItem>
                    <SelectItem value="weekly">Weekly digest</SelectItem>
                  </SelectContent>
                </Select>
              </Fld>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Advanced */}
        <TabsContent value="advanced" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Custom domain</CardTitle>
              <CardDescription>Serve the portal from your own domain</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-3">
              <Fld label="Portal domain">
                <Input defaultValue="portal.muenot.com" className="w-64 font-mono text-xs" />
              </Fld>
              <Button size="sm" variant="outline" onClick={() => toast.success("Verifying DNS…")}>
                Verify DNS
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Data & retention</CardTitle>
              <CardDescription>Compliance and lifecycle policies</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              <ToggleRow label="Audit log retention" desc="Keep audit logs for 7 years (immutable)" />
              <ToggleRow label="Auto-archive inactive vendors" desc="Archive vendors with no activity for 24 months" on={false} />
              <ToggleRow label="Allow data export requests" desc="Let vendors request a copy of their data" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm text-destructive">Danger zone</CardTitle>
              <CardDescription>Irreversible portal-wide actions</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button size="sm" variant="destructive" onClick={() => toast.success("All vendor sessions revoked")}>
                Revoke all sessions
              </Button>
              <Button size="sm" variant="outline" onClick={() => toast.success("Portal reset scheduled")}>
                Reset portal settings
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
