import type { TableQueryOptions } from "@/lib/table-query"

/** Public sort keys → trusted SQL. Keys mirror the clients list UI's column keys. */
export const CLIENT_TABLE_QUERY: TableQueryOptions = {
  sortable: {
    client: "c.client_name",
    company: "c.company_name",
    location: "c.city",
    login: "c.login_allowed",
    status: "c.status",
    created_at: "c.created_at",
  },
  filters: { status: ["Active", "Inactive"], login: ["Yes", "No"] },
  defaultPageSize: 25,
}
