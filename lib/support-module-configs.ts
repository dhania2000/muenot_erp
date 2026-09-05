/**
 * Single source of truth for the config-driven Support modules (Tickets and
 * Orders). Mirrors the Finance / Recruitment module architecture
 * (lib/recruitment-module-configs.ts): each module is described once by a
 * ModuleConfig, and the shared CRUD factory (lib/support-crud.ts), the generic
 * list client and the generic form dialog are all driven from that config.
 *
 * Modelled on the Worksuite Support screens (Tickets + Orders) so the fields
 * map cleanly onto that workflow.
 */
import { num, round2 } from "@/lib/finance-calc"
import type { FieldDef, FieldType, ModuleConfig } from "@/lib/finance-schema"

/** Terse field builder. */
function fld(section: string, key: string, label: string, type: FieldType = "text", extra: Partial<FieldDef> = {}): FieldDef {
  return { section, key, label, type, ...extra }
}

const TICKET_PRIORITIES = ["Low", "Medium", "High", "Urgent"]
const TICKET_STATUSES = ["Open", "Pending", "In Progress", "Resolved", "Closed"]
const TICKET_CHANNELS = ["Email", "Phone", "Web", "Chat", "In Person"]
const ORDER_STATUSES = ["Pending", "Processing", "Completed", "Cancelled", "Refunded"]
const PAYMENT_STATUSES = ["Unpaid", "Partial", "Paid"]

// ---------------------------------------------------------------------------
// 1. Tickets  (TKT-#### id)
// ---------------------------------------------------------------------------
const tickets: ModuleConfig = {
  key: "tickets",
  table: "support_tickets",
  label: "Tickets",
  subtitle: "Support workspace",
  addLabel: "Create ticket",
  idColumn: "ticket_id",
  idPrefix: "TKT",
  editableId: true,
  dateColumn: "requested_on",
  statusColumn: "status",
  searchColumns: ["ticket_id", "subject", "requester_name", "requester_email", "agent", "ticket_type"],
  fields: [
    fld("Ticket", "ticket_id", "Ticket ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Ticket", "requested_on", "Requested on", "date", { required: true }),
    fld("Ticket", "subject", "Subject", "text", { required: true }),
    fld("Ticket", "ticket_type", "Type", "text", { placeholder: "e.g. Bug, Question, Feature" }),
    fld("Requester", "requester_name", "Requester name", "text", { required: true }),
    fld("Requester", "requester_email", "Requester email", "text"),
    fld("Requester", "requester_phone", "Requester phone", "text"),
    fld("Requester", "channel", "Channel", "select", { options: TICKET_CHANNELS, optional: true }),
    fld("Assignment", "agent", "Assigned agent", "text"),
    fld("Assignment", "priority", "Priority", "select", { options: TICKET_PRIORITIES, optional: true }),
    fld("Assignment", "status", "Status", "select", { options: TICKET_STATUSES }),
    fld("Details", "description", "Description", "textarea"),
    fld("Resolution", "resolution", "Resolution", "textarea"),
    fld("Resolution", "resolved_on", "Resolved on", "date"),
    fld("Resolution", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "ticket_id", label: "Ticket #", mono: true },
    { key: "subject", label: "Subject", sub: "ticket_type" },
    { key: "requester_name", label: "Requester", sub: "requester_email" },
    { key: "requested_on", label: "Requested" },
    { key: "agent", label: "Agent" },
    { key: "priority", label: "Priority", badge: { Urgent: "destructive", High: "default", Medium: "secondary", Low: "outline" } },
    { key: "status", label: "Status", badge: { Open: "default", "In Progress": "secondary", Pending: "outline", Resolved: "secondary", Closed: "outline" } },
  ],
  kpis: [
    { label: "Total Tickets", key: "total_rows", icon: "Ticket" },
    { label: "Open", key: "open_tickets", icon: "Inbox" },
    { label: "Pending", key: "pending_tickets", icon: "Clock" },
    { label: "Resolved", key: "resolved_tickets", icon: "CheckCircle2" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(status = 'Open'),0) open_tickets, COALESCE(SUM(status IN ('Pending','In Progress')),0) pending_tickets, COALESCE(SUM(status IN ('Resolved','Closed')),0) resolved_tickets",
}

// ---------------------------------------------------------------------------
// 2. Orders  (ORD-#### id)
// ---------------------------------------------------------------------------
const orders: ModuleConfig = {
  key: "orders",
  table: "support_orders",
  label: "Orders",
  subtitle: "Support workspace",
  addLabel: "Add order",
  idColumn: "order_id",
  idPrefix: "ORD",
  editableId: true,
  dateColumn: "order_date",
  statusColumn: "status",
  searchColumns: ["order_id", "client_name", "client_email", "item_description"],
  fields: [
    fld("Order", "order_id", "Order number", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Order", "order_date", "Order date", "date", { required: true }),
    fld("Order", "client_name", "Client", "text", { required: true }),
    fld("Order", "client_email", "Client email", "text"),
    fld("Items", "item_description", "Item description", "textarea"),
    fld("Items", "quantity", "Quantity", "number"),
    fld("Items", "unit_price", "Unit price", "number", { money: true }),
    fld("Items", "subtotal", "Subtotal", "number", { money: true, computed: true }),
    fld("Items", "tax_percent", "Tax %", "number"),
    fld("Items", "tax_amount", "Tax amount", "number", { money: true, computed: true }),
    fld("Items", "total_amount", "Total", "number", { money: true, computed: true }),
    fld("Status", "status", "Status", "select", { options: ORDER_STATUSES }),
    fld("Status", "payment_status", "Payment status", "select", { options: PAYMENT_STATUSES, optional: true }),
    fld("Status", "delivery_date", "Delivery date", "date"),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => {
    const subtotal = round2(num(v.quantity) * num(v.unit_price))
    const taxAmount = round2((subtotal * num(v.tax_percent)) / 100)
    const total = round2(subtotal + taxAmount)
    return { subtotal, tax_amount: taxAmount, total_amount: total }
  },
  tableColumns: [
    { key: "order_id", label: "Order #", mono: true },
    { key: "client_name", label: "Client", sub: "client_email" },
    { key: "order_date", label: "Date" },
    { key: "total_amount", label: "Total", align: "right", money: true },
    { key: "payment_status", label: "Payment", badge: { Paid: "secondary", Partial: "outline", Unpaid: "destructive" } },
    { key: "status", label: "Status", badge: { Completed: "secondary", Processing: "default", Pending: "outline", Cancelled: "destructive", Refunded: "destructive" } },
  ],
  kpis: [
    { label: "Total Orders", key: "total_rows", icon: "ShoppingCart" },
    { label: "Order Value", key: "total_value", icon: "Coins", money: true },
    { label: "Completed", key: "completed_orders", icon: "PackageCheck" },
    { label: "Pending", key: "pending_orders", icon: "Package" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(total_amount),0) total_value, COALESCE(SUM(status = 'Completed'),0) completed_orders, COALESCE(SUM(status IN ('Pending','Processing')),0) pending_orders",
}

export const SUPPORT_MODULE_CONFIGS: Record<string, ModuleConfig> = {
  tickets,
  orders,
}
