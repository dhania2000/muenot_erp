"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MoreHorizontal, Plus, ShieldCheck } from "lucide-react"
import { InviteEmployeeDialog } from "@/components/admin/invite-employee-dialog"
import { PermissionsDialog } from "@/components/admin/permissions-dialog"
import type { ModuleRow, FeatureRow } from "@/lib/permissions"

export type EmployeeRow = {
  id: number
  name: string
  email: string
  role: "admin" | "employee"
  designation: string | null
  status: "active" | "inactive"
  must_change_password: number
  created_at: string
}

export type ModuleWithFeatures = ModuleRow & { features: FeatureRow[] }

export function EmployeesTable({
  initialEmployees,
  modules,
}: {
  initialEmployees: EmployeeRow[]
  modules: ModuleWithFeatures[]
}) {
  const router = useRouter()
  const [employees, setEmployees] = useState(initialEmployees)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [permissionsTarget, setPermissionsTarget] = useState<EmployeeRow | null>(null)

  function upsertEmployee(employee: EmployeeRow) {
    setEmployees((prev) => [employee, ...prev.filter((e) => e.id !== employee.id)])
  }

  async function toggleStatus(employee: EmployeeRow) {
    const nextStatus = employee.status === "active" ? "inactive" : "active"
    const res = await fetch(`/api/admin/employees/${employee.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    })
    if (res.ok) {
      setEmployees((prev) =>
        prev.map((e) => (e.id === employee.id ? { ...e, status: nextStatus } : e)),
      )
    }
  }

  async function deleteEmployee(employee: EmployeeRow) {
    if (!confirm(`Remove ${employee.name}? This cannot be undone.`)) return
    const res = await fetch(`/api/admin/employees/${employee.id}`, { method: "DELETE" })
    if (res.ok) {
      setEmployees((prev) => prev.filter((e) => e.id !== employee.id))
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => setInviteOpen(true)}>
          <Plus />
          Invite employee
        </Button>
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Designation</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {employees.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  No employees yet. Invite your first team member to get started.
                </TableCell>
              </TableRow>
            )}
            {employees.map((employee) => (
              <TableRow key={employee.id}>
                <TableCell className="font-medium">{employee.name}</TableCell>
                <TableCell className="text-muted-foreground">{employee.email}</TableCell>
                <TableCell className="text-muted-foreground">{employee.designation || "—"}</TableCell>
                <TableCell>
                  {employee.role === "admin" ? (
                    <Badge variant="secondary" className="gap-1">
                      <ShieldCheck className="size-3" />
                      Admin
                    </Badge>
                  ) : (
                    <Badge variant={employee.status === "active" ? "default" : "outline"}>
                      {employee.status === "active" ? "Active" : "Inactive"}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {employee.role !== "admin" && (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Actions" />}>
                        <MoreHorizontal className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setPermissionsTarget(employee)}>
                          Manage permissions
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => toggleStatus(employee)}>
                          {employee.status === "active" ? "Deactivate" : "Activate"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => deleteEmployee(employee)}
                        >
                          Remove employee
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <InviteEmployeeDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={(employee) => {
          upsertEmployee(employee)
          router.refresh()
        }}
      />

      <PermissionsDialog
        employee={permissionsTarget}
        modules={modules}
        onOpenChange={(open) => {
          if (!open) setPermissionsTarget(null)
        }}
      />
    </div>
  )
}
