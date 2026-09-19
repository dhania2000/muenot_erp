import { jobMonitorResponse } from "@/lib/job-monitoring-api"
export const dynamic = "force-dynamic"
export async function GET(request: Request) { return jobMonitorResponse(request, "tenant") }
