import { UsersLifecycleManager } from "@/components/admin/users-lifecycle-manager"

/**
 * SPEC 14 — User lifecycle admin console. Data is loaded client-side via SWR
 * from the tenant-scoped, admin-guarded /api/admin/users routes, so this page
 * is a thin server wrapper. The admin layout already enforces the admin role.
 */
export default function AdminUsersPage() {
  return <UsersLifecycleManager />
}
