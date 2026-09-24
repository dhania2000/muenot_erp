"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { toast } from "sonner"
import { Plus, ShieldCheck, Wallet } from "lucide-react"
import { SectionHeader, Panel, RowActions } from "@/components/vendor-portal-admin/shared"
import {
  ACCESS_PROFILES,
  ACCESS_RESOURCES,
  PERMISSION_LEVELS,
  FINANCE_RESOURCES,
} from "@/lib/vendor-portal/admin-data"

const RELEVANT_LEVELS: Record<string, readonly string[]> = {
  Dashboard: ["No Access", "View"],
  "Invoice Submission": ["No Access", "Create", "Submit"],
  Invoices: ["No Access", "View", "Download", "Create", "Submit"],
  Documents: ["No Access", "View", "Download", "Upload"],
  Payments: ["No Access", "View", "Download"],
  Contracts: ["No Access", "View", "Download", "Comment"],
  "Support Tickets": ["No Access", "View", "Create", "Comment"],
}

export function AccessControlSection() {
  const [profile, setProfile] = useState(ACCESS_PROFILES[0].name)

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Access & Permissions"
        description="Manage vendor access profiles, the module-level permission matrix and finance-specific data visibility."
        actions={
          <Button size="sm" onClick={() => toast.success("New access profile created")}>
            <Plus data-icon="inline-start" className="size-4" /> New profile
          </Button>
        }
      />

      <Tabs defaultValue="profiles">
        <TabsList>
          <TabsTrigger value="profiles">Access Profiles</TabsTrigger>
          <TabsTrigger value="matrix">Permission Matrix</TabsTrigger>
          <TabsTrigger value="finance">Finance Access</TabsTrigger>
        </TabsList>

        {/* Profiles */}
        <TabsContent value="profiles" className="pt-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {ACCESS_PROFILES.map((p) => (
              <Card key={p.id} className="gap-3">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <ShieldCheck className="size-4" />
                      </div>
                      <div>
                        <CardTitle className="text-sm">{p.name}</CardTitle>
                        <CardDescription className="text-xs">{p.users} users</CardDescription>
                      </div>
                    </div>
                    {p.system ? (
                      <Badge variant="outline" className="text-[10px]">
                        System
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        Custom
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex items-end justify-between gap-2">
                  <p className="text-xs text-muted-foreground">{p.description}</p>
                  <RowActions
                    label="Profile"
                    actions={[
                      { label: "Edit permissions" },
                      { label: "Duplicate" },
                      { label: "Assign to vendors" },
                      { label: "Delete", destructive: !p.system, separatorBefore: true },
                    ]}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* Permission matrix */}
        <TabsContent value="matrix" className="pt-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">Editing profile</span>
            <Select value={profile} onValueChange={setProfile}>
              <SelectTrigger size="sm" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_PROFILES.map((p) => (
                  <SelectItem key={p.id} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => toast.success("Permission matrix saved")}>
              Save changes
            </Button>
          </div>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-64">Portal resource</TableHead>
                  <TableHead>Permission level</TableHead>
                  <TableHead className="text-right">Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ACCESS_RESOURCES.map((res, i) => {
                  const levels = RELEVANT_LEVELS[res] ?? PERMISSION_LEVELS
                  const defaultLevel = profile === "Viewer" ? "View" : i % 4 === 0 ? "Submit" : "View"
                  return (
                    <TableRow key={res}>
                      <TableCell className="font-medium">{res}</TableCell>
                      <TableCell>
                        <Select defaultValue={levels.includes(defaultLevel) ? defaultLevel : levels[levels.length - 1]}>
                          <SelectTrigger size="sm" className="w-40">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {levels.map((l) => (
                              <SelectItem key={l} value={l}>
                                {l}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="text-right">
                        <Switch defaultChecked={profile !== "Viewer" || i < 6} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </Panel>
        </TabsContent>

        {/* Finance access */}
        <TabsContent value="finance" className="pt-4">
          <Panel className="mb-3 flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Wallet className="size-4" />
            Control which finance records each vendor can see in the portal. Changes apply to all users of the selected profile.
          </Panel>
          <Panel>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-64">Finance resource</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead>Historical range</TableHead>
                  <TableHead className="text-right">Enabled</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {FINANCE_RESOURCES.map((res, i) => (
                  <TableRow key={res}>
                    <TableCell className="font-medium">{res}</TableCell>
                    <TableCell>
                      <Select defaultValue={i % 3 === 0 ? "own" : "own"}>
                        <SelectTrigger size="sm" className="w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="own">Own records only</SelectItem>
                          <SelectItem value="none">Hidden</SelectItem>
                          <SelectItem value="summary">Summary only</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select defaultValue="12m">
                        <SelectTrigger size="sm" className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="3m">Last 3 months</SelectItem>
                          <SelectItem value="12m">Last 12 months</SelectItem>
                          <SelectItem value="all">All history</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-right">
                      <Switch defaultChecked={i < 8} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        </TabsContent>
      </Tabs>
    </div>
  )
}
