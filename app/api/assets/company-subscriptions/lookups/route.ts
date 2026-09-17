import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { listVendors, listEmployees, listDepartments, listServices } from "@/lib/company-subscriptions"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const session = await requireFeature("assets.view_company_subscriptions")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const sp = req.nextUrl.searchParams
  const [vendors, employees, departments, services] = await Promise.all([
    listVendors(sp.get("vendor_search")),
    listEmployees(sp.get("employee_search")),
    listDepartments(),
    listServices(sp.get("service_search")),
  ])
  return NextResponse.json({ vendors, employees, departments, services })
}
