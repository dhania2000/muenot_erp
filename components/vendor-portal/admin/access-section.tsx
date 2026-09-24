"use client"

import { useState } from "react"
import { toast } from "sonner"
import { SlidersHorizontal, Plus, Copy, Pencil, Archive, Layers, Wallet, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SectionHeader, StatusBadge, DataCard } from "./shared"
import {
  PORTAL_RESOURCES,
  FINANCE_RESOURCES,
  PERMISSION_LEVELS,
  ACCESS_PROFILES,
  VENDORS,
  type PermissionLevel,
} from "./mock-data"

const SCOPES = [
  { value: "default", label: "Default Level" },
  { value: "vendor", label: "Vendor Level" },
  { value: "role", label: "Role Level" },
  { value: "user", label: "User Override" },
]

// Deterministic default level per resource so the matrix looks realistic.
function defaultLevel(i: number): PermissionLevel {
  const cycle: PermissionLevel[] = ["view", "download", "submit", "no_access", "view", "upload", "comment"]
  return cycle[i % cycle.length]
}

export function AccessSection() {
  const [scope, setScope] = useState("vendor")
  const [vendor, setVendor] = useState(VENDORS[0].id)
  const [levels, setLevels] = useState<Record<string, PermissionLevel>>(
    Object.fromEntries(PORTAL_RESOURCES.map((r, i) => [r, defaultLevel(i)])),
  )
  const [financeLevels, setFinanceLevels] = useState<Record<string, PermissionLevel>>(
    Object.fromEntries(FINANCE_RESOURCES.map((r, i) => [r, defaultLevel(i + 2)])),
  )

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Access & Permission Management"
        description="Control what vendors can access across the portal. Configure resource permissions, reusable access profiles and granular finance controls."
        icon={SlidersHorizontal}
      />

      <Tabs defaultValue="permissions" className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="permissions">
            <Layers className="size-4" /> Permissions
          </TabsTrigger>
          <TabsTrigger value="profiles">
            <ShieldCheck className="size-4" /> Access Profiles
          </TabsTrigger>
          <TabsTrigger value="finance">
            <Wallet className="size-4" /> Financial Access
          </TabsTrigger>
        </TabsList>

        {/* Permission matrix */}
        <TabsContent value="permissions" className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">Scope</span>
              <Select value={scope} onValueChange={(v) => setScope(v as string)}>
                <SelectTrigger className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {scope === "vendor" || scope === "user" ? (
              <div className="grid gap-1.5">
                <span className="text-xs text-muted-foreground">Vendor</span>
                <Select value={vendor} onValueChange={(v) => setVendor(v as string)}>
                  <SelectTrigger className="w-56">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VENDORS.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="ml-auto flex items-end">
              <Button size="sm" onClick={() => toast.success("Permissions saved")}>
                Save permissions
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs text-blue-700 dark:text-blue-300">
            <Layers className="size-4" />
            Permissions inherit from Default → Vendor → Role → User. Overrides at a more specific scope take precedence.
          </div>

          <DataCard>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="px-3">Resource</TableHead>
                  <TableHead className="px-3">Permission level</TableHead>
                  <TableHead className="px-3">Inherited from</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PORTAL_RESOURCES.map((r, i) => (
                  <TableRow key={r}>
                    <TableCell className="px-3 text-sm font-medium">{r}</TableCell>
                    <TableCell className="px-3">
                      <Select
                        value={levels[r]}
                        onValueChange={(v) => setLevels((p) => ({ ...p, [r]: v as PermissionLevel }))}
                      >
                        <SelectTrigger className="h-7 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PERMISSION_LEVELS.map((l) => (
                            <SelectItem key={l.value} value={l.value}>
                              {l.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="px-3">
                      <StatusBadge
                        tone={i % 3 === 0 ? "info" : "neutral"}
                        label={i % 3 === 0 ? "Role Level" : "Default"}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataCard>
        </TabsContent>

        {/* Access profiles */}
        <TabsContent value="profiles" className="grid gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Reusable permission bundles you can assign to vendors and users.</p>
            <Button size="sm" onClick={() => toast.success("New profile")}>
              <Plus className="size-4" /> Create Profile
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ACCESS_PROFILES.map((p) => (
              <Card key={p.id} size="sm">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{p.name}</CardTitle>
                    {p.builtIn ? (
                      <StatusBadge tone="neutral" label="Built-in" />
                    ) : (
                      <StatusBadge tone="info" label="Custom" />
                    )}
                  </div>
                  <CardDescription>{p.description}</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{p.users} users</span>
                    <span>{p.resources} resources</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => toast.success("Assign profile")}>
                      Assign
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => toast.success("Profile cloned")}>
                      <Copy className="size-3.5" /> Clone
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => toast.success("Edit profile")}>
                      <Pencil className="size-3.5" /> Edit
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => toast.success("Profile archived")}>
                      <Archive className="size-3.5" /> Archive
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Financial access */}
        <TabsContent value="finance" className="grid gap-3">
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <Wallet className="size-4" />
            Vendor Portal is a Finance module. Configure per-vendor and per-role access to sensitive financial records below.
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">Vendor</span>
              <Select value={vendor} onValueChange={(v) => setVendor(v as string)}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VENDORS.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="ml-auto flex items-end">
              <Button size="sm" onClick={() => toast.success("Financial access saved")}>
                Save
              </Button>
            </div>
          </div>
          <DataCard>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="px-3">Financial resource</TableHead>
                  <TableHead className="px-3">Access level</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {FINANCE_RESOURCES.map((r) => (
                  <TableRow key={r}>
                    <TableCell className="px-3 text-sm font-medium">{r}</TableCell>
                    <TableCell className="px-3">
                      <Select
                        value={financeLevels[r]}
                        onValueChange={(v) => setFinanceLevels((p) => ({ ...p, [r]: v as PermissionLevel }))}
                      >
                        <SelectTrigger className="h-7 w-40">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PERMISSION_LEVELS.map((l) => (
                            <SelectItem key={l.value} value={l.value}>
                              {l.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataCard>
        </TabsContent>
      </Tabs>
    </div>
  )
}
