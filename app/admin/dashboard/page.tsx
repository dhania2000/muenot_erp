import { AdminControlCenter } from "@/components/admin/admin-control-center"

// The tenant control center now lives on its own "Dashboard" sub-module under
// Administration (see ADMINISTRATION_CHILDREN in lib/workspace-nav.tsx) instead
// of being shown on the Administration landing page.
export default function AdminDashboardPage() {
  return <AdminControlCenter />
}
