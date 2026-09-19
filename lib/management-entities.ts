/**
 * Management module — shared entity registry (client + server safe).
 * ---------------------------------------------------------------------------
 * A GLPI-style "Management" section made of 13 master-data entities. Every
 * entity is described declaratively here (fields, types, table name, record-id
 * prefix). Both the server engine (lib/management.ts) and the generic client
 * (components/management/management-entity-client.tsx) are driven entirely by
 * this config, so adding a field or a whole entity is a data-only change.
 *
 * IMPORTANT: this file must stay free of server-only imports so it can be used
 * from client components. It contains NO database access.
 */

export type FieldType = "text" | "textarea" | "number" | "date" | "email" | "select"

export type FieldDef = {
  /** Column name in the database and key in the API payload. */
  name: string
  label: string
  type: FieldType
  required?: boolean
  /** Options for a `select` field. */
  options?: string[]
  /** Whether the field is shown as a column in the list table. */
  inTable?: boolean
  placeholder?: string
}

export type EntityDef = {
  /** URL slug, e.g. "licenses". */
  key: string
  /** Menu / singular label, e.g. "Licenses". */
  label: string
  /** Page heading, e.g. "Licenses". */
  title: string
  description: string
  /** lucide-react icon name, mapped to a component on the client. */
  icon: string
  /** Record-id prefix, e.g. "LIC" -> LIC-000001. */
  prefix: string
  /** Database table name. */
  table: string
  fields: FieldDef[]
}

const STATUS = (options: string[]): FieldDef => ({
  name: "status",
  label: "Status",
  type: "select",
  options,
  inTable: true,
})

const NOTES: FieldDef = { name: "notes", label: "Notes", type: "textarea" }

export const MANAGEMENT_ENTITIES: EntityDef[] = [
  {
    key: "licenses",
    label: "Licenses",
    title: "Licenses",
    description: "Software licenses, seats, keys and renewals.",
    icon: "KeyRound",
    prefix: "LIC",
    table: "mgmt_licenses",
    fields: [
      { name: "name", label: "License Name", type: "text", required: true, inTable: true },
      { name: "publisher", label: "Publisher", type: "text", inTable: true },
      { name: "product_key", label: "Product Key", type: "text" },
      {
        name: "license_type",
        label: "License Type",
        type: "select",
        options: ["Perpetual", "Subscription", "OEM", "Volume", "Trial"],
        inTable: true,
      },
      { name: "seats", label: "Total Seats", type: "number" },
      { name: "assigned_seats", label: "Assigned Seats", type: "number" },
      { name: "vendor", label: "Vendor", type: "text" },
      { name: "purchase_date", label: "Purchase Date", type: "date" },
      { name: "expiry_date", label: "Expiry Date", type: "date", inTable: true },
      { name: "cost", label: "Cost", type: "number" },
      STATUS(["Active", "Expired", "Cancelled", "Suspended"]),
      NOTES,
    ],
  },
  {
    key: "budgets",
    label: "Budgets",
    title: "Budgets",
    description: "Cost centres, allocations and periods.",
    icon: "PiggyBank",
    prefix: "BUD",
    table: "mgmt_budgets",
    fields: [
      { name: "name", label: "Budget Name", type: "text", required: true, inTable: true },
      {
        name: "budget_type",
        label: "Budget Type",
        type: "select",
        options: ["Operational", "Capital", "Project", "Departmental"],
        inTable: true,
      },
      { name: "amount", label: "Amount", type: "number", inTable: true },
      { name: "owner", label: "Owner", type: "text" },
      { name: "department", label: "Department", type: "text", inTable: true },
      { name: "start_date", label: "Start Date", type: "date" },
      { name: "end_date", label: "End Date", type: "date" },
      STATUS(["Draft", "Active", "Closed"]),
      NOTES,
    ],
  },
  {
    key: "suppliers",
    label: "Suppliers",
    title: "Suppliers",
    description: "Vendors and service providers.",
    icon: "Truck",
    prefix: "SUP",
    table: "mgmt_suppliers",
    fields: [
      { name: "name", label: "Supplier Name", type: "text", required: true, inTable: true },
      { name: "contact_person", label: "Contact Person", type: "text", inTable: true },
      { name: "email", label: "Email", type: "email", inTable: true },
      { name: "phone", label: "Phone", type: "text" },
      { name: "website", label: "Website", type: "text" },
      { name: "gstin", label: "GSTIN / Tax ID", type: "text" },
      { name: "address", label: "Address", type: "textarea" },
      { name: "city", label: "City", type: "text" },
      { name: "country", label: "Country", type: "text" },
      STATUS(["Active", "Inactive"]),
      NOTES,
    ],
  },
  {
    key: "contacts",
    label: "Contacts",
    title: "Contacts",
    description: "People associated with suppliers and assets.",
    icon: "Contact",
    prefix: "CTC",
    table: "mgmt_contacts",
    fields: [
      { name: "first_name", label: "First Name", type: "text", required: true, inTable: true },
      { name: "last_name", label: "Last Name", type: "text", inTable: true },
      { name: "email", label: "Email", type: "email", inTable: true },
      { name: "phone", label: "Phone", type: "text", inTable: true },
      { name: "title", label: "Job Title", type: "text" },
      { name: "company", label: "Company", type: "text", inTable: true },
      { name: "address", label: "Address", type: "textarea" },
      { name: "city", label: "City", type: "text" },
      { name: "country", label: "Country", type: "text" },
      STATUS(["Active", "Inactive"]),
      NOTES,
    ],
  },
  {
    key: "contracts",
    label: "Contracts",
    title: "Contracts",
    description: "Agreements, terms, values and renewals.",
    icon: "FileSignature",
    prefix: "CTR",
    table: "mgmt_contracts",
    fields: [
      { name: "name", label: "Contract Name", type: "text", required: true, inTable: true },
      { name: "contract_number", label: "Contract Number", type: "text", inTable: true },
      { name: "supplier", label: "Supplier", type: "text", inTable: true },
      {
        name: "contract_type",
        label: "Contract Type",
        type: "select",
        options: ["Service", "Lease", "Maintenance", "License", "Support", "Other"],
        inTable: true,
      },
      { name: "value", label: "Value", type: "number" },
      { name: "start_date", label: "Start Date", type: "date" },
      { name: "end_date", label: "End Date", type: "date", inTable: true },
      { name: "renewal", label: "Auto Renewal", type: "select", options: ["Yes", "No"] },
      STATUS(["Draft", "Active", "Expired", "Terminated"]),
      NOTES,
    ],
  },
  {
    key: "documents",
    label: "Documents",
    title: "Documents",
    description: "Reference documents and files.",
    icon: "FileText",
    prefix: "DCM",
    table: "mgmt_documents",
    fields: [
      { name: "name", label: "Document Name", type: "text", required: true, inTable: true },
      { name: "doc_type", label: "Type", type: "text", inTable: true },
      { name: "category", label: "Category", type: "text", inTable: true },
      { name: "owner", label: "Owner", type: "text" },
      { name: "version", label: "Version", type: "text" },
      { name: "url", label: "Link / URL", type: "text" },
      { name: "expiry_date", label: "Expiry Date", type: "date", inTable: true },
      STATUS(["Active", "Archived"]),
      NOTES,
    ],
  },
  {
    key: "phone-lines",
    label: "Phone lines",
    title: "Phone Lines",
    description: "Telephony numbers, plans and assignments.",
    icon: "Phone",
    prefix: "PHL",
    table: "mgmt_phone_lines",
    fields: [
      { name: "number", label: "Phone Number", type: "text", required: true, inTable: true },
      { name: "provider", label: "Provider", type: "text", inTable: true },
      { name: "plan", label: "Plan", type: "text" },
      { name: "assigned_to", label: "Assigned To", type: "text", inTable: true },
      { name: "monthly_cost", label: "Monthly Cost", type: "number" },
      { name: "activation_date", label: "Activation Date", type: "date" },
      STATUS(["Active", "Suspended", "Cancelled"]),
      NOTES,
    ],
  },
  {
    key: "certificates",
    label: "Certificates",
    title: "Certificates",
    description: "SSL and signing certificates with expiry tracking.",
    icon: "BadgeCheck",
    prefix: "CRT",
    table: "mgmt_certificates",
    fields: [
      { name: "name", label: "Certificate Name", type: "text", required: true, inTable: true },
      {
        name: "cert_type",
        label: "Type",
        type: "select",
        options: ["SSL/TLS", "Code Signing", "Client", "CA", "Other"],
        inTable: true,
      },
      { name: "domain", label: "Domain / CN", type: "text", inTable: true },
      { name: "issuer", label: "Issuer", type: "text", inTable: true },
      { name: "issued_date", label: "Issued Date", type: "date" },
      { name: "expiry_date", label: "Expiry Date", type: "date", inTable: true },
      STATUS(["Valid", "Expired", "Revoked"]),
      NOTES,
    ],
  },
  {
    key: "data-centers",
    label: "Data centers",
    title: "Data Centers",
    description: "Physical and cloud data-center sites.",
    icon: "Building2",
    prefix: "DTC",
    table: "mgmt_data_centers",
    fields: [
      { name: "name", label: "Data Center Name", type: "text", required: true, inTable: true },
      { name: "provider", label: "Provider", type: "text", inTable: true },
      { name: "location", label: "Location", type: "text", inTable: true },
      { name: "tier", label: "Tier", type: "select", options: ["Tier I", "Tier II", "Tier III", "Tier IV"], inTable: true },
      { name: "capacity", label: "Capacity", type: "text" },
      { name: "address", label: "Address", type: "textarea" },
      { name: "city", label: "City", type: "text" },
      { name: "country", label: "Country", type: "text" },
      STATUS(["Active", "Inactive"]),
      NOTES,
    ],
  },
  {
    key: "clusters",
    label: "Clusters",
    title: "Clusters",
    description: "Compute / service clusters and nodes.",
    icon: "Network",
    prefix: "CLS",
    table: "mgmt_clusters",
    fields: [
      { name: "name", label: "Cluster Name", type: "text", required: true, inTable: true },
      { name: "cluster_type", label: "Type", type: "text", inTable: true },
      { name: "data_center", label: "Data Center", type: "text", inTable: true },
      { name: "node_count", label: "Nodes", type: "number", inTable: true },
      { name: "version", label: "Version", type: "text" },
      {
        name: "environment",
        label: "Environment",
        type: "select",
        options: ["Production", "Staging", "Development", "Test"],
        inTable: true,
      },
      STATUS(["Active", "Inactive"]),
      NOTES,
    ],
  },
  {
    key: "domains",
    label: "Domains",
    title: "Domains",
    description: "DNS domains, registrars and renewals.",
    icon: "Globe",
    prefix: "DOM",
    table: "mgmt_domains",
    fields: [
      { name: "name", label: "Domain Name", type: "text", required: true, inTable: true },
      { name: "registrar", label: "Registrar", type: "text", inTable: true },
      { name: "registration_date", label: "Registration Date", type: "date" },
      { name: "expiry_date", label: "Expiry Date", type: "date", inTable: true },
      { name: "auto_renew", label: "Auto Renew", type: "select", options: ["Yes", "No"], inTable: true },
      { name: "name_servers", label: "Name Servers", type: "textarea" },
      STATUS(["Active", "Expired", "Pending"]),
      NOTES,
    ],
  },
  {
    key: "appliances",
    label: "Appliances",
    title: "Appliances",
    description: "Network and hardware appliances.",
    icon: "Server",
    prefix: "APP",
    table: "mgmt_appliances",
    fields: [
      { name: "name", label: "Appliance Name", type: "text", required: true, inTable: true },
      { name: "appliance_type", label: "Type", type: "text", inTable: true },
      { name: "manufacturer", label: "Manufacturer", type: "text", inTable: true },
      { name: "model", label: "Model", type: "text" },
      { name: "serial_number", label: "Serial Number", type: "text" },
      { name: "location", label: "Location", type: "text", inTable: true },
      { name: "ip_address", label: "IP Address", type: "text" },
      STATUS(["Active", "Inactive", "Maintenance", "Retired"]),
      NOTES,
    ],
  },
  {
    key: "databases",
    label: "Databases",
    title: "Databases",
    description: "Database instances and engines.",
    icon: "Database",
    prefix: "DBS",
    table: "mgmt_databases",
    fields: [
      { name: "name", label: "Database Name", type: "text", required: true, inTable: true },
      {
        name: "db_engine",
        label: "Engine",
        type: "select",
        options: ["MySQL", "PostgreSQL", "MongoDB", "Oracle", "SQL Server", "Redis", "Other"],
        inTable: true,
      },
      { name: "version", label: "Version", type: "text", inTable: true },
      { name: "host", label: "Host", type: "text", inTable: true },
      { name: "port", label: "Port", type: "number" },
      { name: "size_gb", label: "Size (GB)", type: "number" },
      {
        name: "environment",
        label: "Environment",
        type: "select",
        options: ["Production", "Staging", "Development", "Test"],
        inTable: true,
      },
      STATUS(["Active", "Inactive", "Archived"]),
      NOTES,
    ],
  },
]

const ENTITY_MAP = new Map(MANAGEMENT_ENTITIES.map((e) => [e.key, e]))

export function getEntityDef(key: string): EntityDef | undefined {
  return ENTITY_MAP.get(key)
}

/** The columns to search with a free-text query (text/email fields only). */
export function searchFields(entity: EntityDef): string[] {
  return entity.fields.filter((f) => f.type === "text" || f.type === "email").map((f) => f.name)
}

/** Whether the entity exposes a `status` select for filtering. */
export function statusField(entity: EntityDef): FieldDef | undefined {
  return entity.fields.find((f) => f.name === "status")
}
