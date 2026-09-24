"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  ClipboardList,
  Plus,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Trash2,
  Settings2,
  Eye,
  Type,
  Hash,
  Calendar,
  ListChecks,
  ToggleLeft,
  Upload,
  Mail,
  AtSign,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { SectionHeader, StatusBadge, DataCard } from "./shared"

type FieldType = "text" | "number" | "email" | "date" | "select" | "toggle" | "file"

const FIELD_TYPE_META: Record<FieldType, { label: string; icon: typeof Type }> = {
  text: { label: "Text", icon: Type },
  number: { label: "Number", icon: Hash },
  email: { label: "Email", icon: AtSign },
  date: { label: "Date", icon: Calendar },
  select: { label: "Dropdown", icon: ListChecks },
  toggle: { label: "Yes / No", icon: ToggleLeft },
  file: { label: "File upload", icon: Upload },
}

type FormField = {
  id: string
  label: string
  type: FieldType
  required: boolean
  enabled: boolean
}

type FormSection = {
  id: string
  title: string
  description: string
  fields: FormField[]
}

const INITIAL_FORM: FormSection[] = [
  {
    id: "sec-company",
    title: "Company Information",
    description: "Legal identity and business classification.",
    fields: [
      { id: "f1", label: "Legal company name", type: "text", required: true, enabled: true },
      { id: "f2", label: "Trading name", type: "text", required: false, enabled: true },
      { id: "f3", label: "Vendor type", type: "select", required: true, enabled: true },
      { id: "f4", label: "Country of incorporation", type: "select", required: true, enabled: true },
      { id: "f5", label: "Year established", type: "number", required: false, enabled: false },
    ],
  },
  {
    id: "sec-contact",
    title: "Primary Contact",
    description: "Main point of contact for the vendor account.",
    fields: [
      { id: "f6", label: "Contact name", type: "text", required: true, enabled: true },
      { id: "f7", label: "Work email", type: "email", required: true, enabled: true },
      { id: "f8", label: "Phone number", type: "text", required: true, enabled: true },
      { id: "f9", label: "Designation", type: "text", required: false, enabled: true },
    ],
  },
  {
    id: "sec-tax",
    title: "Tax & Banking",
    description: "Financial and statutory identifiers.",
    fields: [
      { id: "f10", label: "GST / VAT number", type: "text", required: true, enabled: true },
      { id: "f11", label: "PAN / Tax ID", type: "text", required: true, enabled: true },
      { id: "f12", label: "Bank account proof", type: "file", required: true, enabled: true },
      { id: "f13", label: "MSME registered", type: "toggle", required: false, enabled: true },
    ],
  },
  {
    id: "sec-docs",
    title: "Documents",
    description: "Statutory and compliance uploads.",
    fields: [
      { id: "f14", label: "Certificate of incorporation", type: "file", required: true, enabled: true },
      { id: "f15", label: "GST certificate", type: "file", required: true, enabled: true },
      { id: "f16", label: "ISO / quality certification", type: "file", required: false, enabled: false },
    ],
  },
]

const SETTINGS_TOGGLES = [
  { label: "Allow vendor self-registration", desc: "Show a public registration link on the portal login page", on: true },
  { label: "Require admin approval", desc: "New applications must be reviewed before an account is created", on: true },
  { label: "Auto-verify email on submit", desc: "Send a verification email as soon as an application is submitted", on: true },
  { label: "Mandatory document upload", desc: "Block submission until all required documents are attached", on: true },
  { label: "Send welcome email on approval", desc: "Email portal credentials automatically after approval", on: true },
  { label: "Duplicate detection", desc: "Warn reviewers when a similar vendor already exists", on: false },
]

const APPROVAL_STAGES = [
  "Application submitted",
  "Document verification",
  "Compliance check",
  "Finance review",
  "Final approval",
  "Account provisioned",
]

export function OnboardingSection() {
  const [form, setForm] = useState<FormSection[]>(INITIAL_FORM)

  function updateField(sectionId: string, fieldId: string, patch: Partial<FormField>) {
    setForm((prev) =>
      prev.map((s) =>
        s.id === sectionId
          ? { ...s, fields: s.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) }
          : s,
      ),
    )
  }

  function moveField(sectionId: string, index: number, dir: -1 | 1) {
    setForm((prev) =>
      prev.map((s) => {
        if (s.id !== sectionId) return s
        const next = [...s.fields]
        const target = index + dir
        if (target < 0 || target >= next.length) return s
        ;[next[index], next[target]] = [next[target], next[index]]
        return { ...s, fields: next }
      }),
    )
  }

  const enabledCount = form.reduce((n, s) => n + s.fields.filter((f) => f.enabled).length, 0)
  const requiredCount = form.reduce((n, s) => n + s.fields.filter((f) => f.enabled && f.required).length, 0)

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Onboarding & Registration Form"
        description="Design the vendor self-registration form, control which fields are collected, and configure the onboarding approval workflow."
        icon={ClipboardList}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => toast.success("Preview opened in vendor view")}>
              <Eye className="size-4" /> Preview
            </Button>
            <Button size="sm" onClick={() => toast.success("Form published to portal")}>
              Publish form
            </Button>
          </>
        }
      />

      <Tabs defaultValue="builder" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="builder">
            <ClipboardList className="size-4" /> Form Builder
          </TabsTrigger>
          <TabsTrigger value="workflow">
            <ListChecks className="size-4" /> Approval Workflow
          </TabsTrigger>
          <TabsTrigger value="settings">
            <Settings2 className="size-4" /> Onboarding Settings
          </TabsTrigger>
        </TabsList>

        {/* Form builder */}
        <TabsContent value="builder" className="grid gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MiniStat label="Sections" value={form.length} />
            <MiniStat label="Enabled fields" value={enabledCount} />
            <MiniStat label="Required fields" value={requiredCount} />
            <MiniStat label="Optional fields" value={enabledCount - requiredCount} />
          </div>

          {form.map((section) => (
            <Card key={section.id} size="sm">
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="grid gap-0.5">
                    <CardTitle className="text-sm">{section.title}</CardTitle>
                    <CardDescription>{section.description}</CardDescription>
                  </div>
                  <div className="flex gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => toast.success("Field added")}>
                      <Plus className="size-3.5" /> Add field
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => toast.success("Section settings")}>
                      <Settings2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="grid gap-2 pt-0">
                {section.fields.map((field, i) => {
                  const Icon = FIELD_TYPE_META[field.type].icon
                  return (
                    <div
                      key={field.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2"
                    >
                      <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
                      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                        <Icon className="size-3.5" />
                      </span>
                      <Input
                        defaultValue={field.label}
                        className="h-7 w-48 flex-1 min-w-40"
                        onBlur={() => undefined}
                      />
                      <Select
                        value={field.type}
                        onValueChange={(v) => updateField(section.id, field.id, { type: v as FieldType })}
                      >
                        <SelectTrigger className="h-7 w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(FIELD_TYPE_META) as FieldType[]).map((t) => (
                            <SelectItem key={t} value={t}>
                              {FIELD_TYPE_META[t].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                          checked={field.required}
                          onCheckedChange={(c) => updateField(section.id, field.id, { required: c })}
                        />
                        Required
                      </label>
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Switch
                          checked={field.enabled}
                          onCheckedChange={(c) => updateField(section.id, field.id, { enabled: c })}
                        />
                        Enabled
                      </label>
                      <div className="ml-auto flex items-center gap-0.5">
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Move up"
                          disabled={i === 0}
                          onClick={() => moveField(section.id, i, -1)}
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Move down"
                          disabled={i === section.fields.length - 1}
                          onClick={() => moveField(section.id, i, 1)}
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label="Delete field"
                          onClick={() => toast.success("Field removed")}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </CardContent>
            </Card>
          ))}

          <Button variant="outline" onClick={() => toast.success("Section added")}>
            <Plus className="size-4" /> Add section
          </Button>
        </TabsContent>

        {/* Approval workflow */}
        <TabsContent value="workflow" className="grid gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            <ListChecks className="size-4" />
            Applications progress through these stages. Drag to reorder or disable stages that are not required.
          </div>
          <DataCard className="p-4">
            <ol className="grid gap-2">
              {APPROVAL_STAGES.map((stage, i) => (
                <li
                  key={stage}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <GripVertical className="size-4 cursor-grab text-muted-foreground" />
                  <span className="inline-flex size-6 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {i + 1}
                  </span>
                  <span className="flex-1 text-sm font-medium">{stage}</span>
                  <Select defaultValue={i === 3 ? "finance" : "admin"}>
                    <SelectTrigger className="h-7 w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Portal Admin</SelectItem>
                      <SelectItem value="finance">Finance Team</SelectItem>
                      <SelectItem value="compliance">Compliance</SelectItem>
                      <SelectItem value="procurement">Procurement</SelectItem>
                    </SelectContent>
                  </Select>
                  <Switch defaultChecked onCheckedChange={() => toast.success("Stage updated")} />
                </li>
              ))}
            </ol>
          </DataCard>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => toast.success("Workflow saved")}>
              Save workflow
            </Button>
          </div>
        </TabsContent>

        {/* Onboarding settings */}
        <TabsContent value="settings" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Registration rules</CardTitle>
              <CardDescription>Control how vendors register and get approved</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {SETTINGS_TOGGLES.map((t) => (
                <div
                  key={t.label}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <div className="grid gap-0.5">
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.desc}</span>
                  </div>
                  <Switch defaultChecked={t.on} onCheckedChange={() => toast.success("Setting updated")} />
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Approval SLA</CardTitle>
                <CardDescription>Target turnaround for each review stage</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <Label className="text-xs">Document verification</Label>
                  <div className="flex items-center gap-2">
                    <Input defaultValue="2" className="w-16" />
                    <span className="text-xs text-muted-foreground">business days</span>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Final approval</Label>
                  <div className="flex items-center gap-2">
                    <Input defaultValue="5" className="w-16" />
                    <span className="text-xs text-muted-foreground">business days</span>
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Default approver team</Label>
                  <Select defaultValue="procurement">
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="procurement">Procurement</SelectItem>
                      <SelectItem value="finance">Finance</SelectItem>
                      <SelectItem value="compliance">Compliance</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Escalation after</Label>
                  <div className="flex items-center gap-2">
                    <Input defaultValue="3" className="w-16" />
                    <span className="text-xs text-muted-foreground">days idle</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Welcome message</CardTitle>
                <CardDescription>Shown to vendors after approval</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="grid gap-1.5">
                  <Label className="flex items-center gap-1.5 text-xs">
                    <Mail className="size-3.5" /> Email subject
                  </Label>
                  <Input defaultValue="Welcome to the Muenot Vendor Portal" />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">Message body</Label>
                  <Textarea
                    rows={5}
                    defaultValue={
                      "Hello,\n\nYour vendor account has been approved. You can now log in to submit invoices, track payments and manage your company profile.\n\nRegards,\nProcurement Team"
                    }
                  />
                </div>
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => toast.success("Message saved")}>
                    Save message
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}
