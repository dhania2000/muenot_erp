import { EmployeeUserLinkManager } from "@/components/admin/employee-user-link-manager"

/**
 * Employee ⇄ User link console. Data is loaded client-side via SWR
 * from the tenant-scoped, admin-guarded /api/admin/employee-links routes, so
 * this page is a thin wrapper. The admin layout already enforces the admin role.
 */
export default function AdminEmployeeLinksPage() {
  return <EmployeeUserLinkManager />
}
