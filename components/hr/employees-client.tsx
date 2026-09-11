"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  Plus,
  Search,
  Users2,
  ShieldCheck,
  Pencil,
  Trash2,
  ExternalLink,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  X,
  Filter,
  Archive,
  ArchiveRestore,
  History,
  MoreHorizontal,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { ExcelImportButton } from "@/components/sales/excel-import-button";
import { ExcelExportButton } from "@/components/excel-export-button";

const EMPLOYEE_IMPORT_ALIASES = Object.fromEntries(
  [
    "employee_name",
    "gender",
    "dob",
    "personal_email",
    "official_email",
    "mobile",
    "alternate_mobile",
    "address",
    "city",
    "state",
    "country",
    "postal_code",
    "emergency_contact_name",
    "emergency_contact_phone",
    "emergency_contact_relation",
    "relative_name",
    "relative_relationship",
    "relative_primary_phone",
    "relative_alternate_phone",
    "relative_email",
    "relative_address",
    "department",
    "designation",
    "reporting_manager",
    "employment_type",
    "joining_date",
    "probation_end_date",
    "confirmation_date",
    "employment_status",
    "onboarding_status",
    "work_location",
    "work_mode",
    "shift",
    "employee_grade",
    "document_status",
    "agreement_status",
    "consent_status",
    "compliance_status",
    "it_access_status",
    "asset_status",
    "training_status",
    "performance_status",
    "notice_period",
    "notice_period_status",
    "exit_status",
    "exit_date",
    "exit_reason",
    "skills",
    "notes",
    "bank_account_holder_name",
    "bank_name",
    "bank_account_number",
    "bank_ifsc_code",
    "bank_branch",
    "bank_account_type",
    "bank_swift_code",
    "bank_pan_number",
    "bank_upi_id",
  ].map((key) => [key, [key, key.replaceAll("_", " ")]]),
) as Record<string, string[]>;
const EMPLOYEE_IMPORT_HEADERS = Object.keys(EMPLOYEE_IMPORT_ALIASES);

const fields = [
  ["employee_name", "Employee Name"],
  ["gender", "Gender"],
  ["dob", "DOB"],
  ["personal_email", "Personal Email"],
  ["official_email", "Official Email"],
  ["mobile", "Mobile"],
  ["alternate_mobile", "Alternate Mobile"],
  ["address", "Address"],
  ["city", "City"],
  ["state", "State"],
  ["country", "Country"],
  ["postal_code", "Postal Code"],
  ["emergency_contact_name", "Emergency Contact Name"],
  ["emergency_contact_phone", "Emergency Contact Phone"],
  ["emergency_contact_relation", "Emergency Contact Relation"],
  ["relative_name", "Relative Name"],
  ["relative_relationship", "Relationship"],
  ["relative_primary_phone", "Primary Phone"],
  ["relative_alternate_phone", "Alternate Phone"],
  ["relative_email", "Email"],
  ["relative_address", "Address"],
  ["department", "Department"],
  ["designation", "Designation"],
  ["reporting_manager", "Reporting Manager"],
  ["employment_type", "Employment Type"],
  ["joining_date", "Joining Date"],
  ["probation_end_date", "Probation End Date"],
  ["confirmation_date", "Confirmation Date"],
  ["employment_status", "Employment Status"],
  ["onboarding_status", "Onboarding Status"],
  ["work_location", "Work Location"],
  ["work_mode", "Work Mode"],
  ["shift", "Shift"],
  ["employee_grade", "Employee Grade"],
  ["document_status", "Document Status"],
  ["agreement_status", "Agreement Status"],
  ["consent_status", "Consent Status"],
  ["compliance_status", "Compliance Status"],
  ["it_access_status", "IT Access Status"],
  ["asset_status", "Asset Status"],
  ["training_status", "Training Status"],
  ["performance_status", "Performance Status"],
  ["notice_period", "Notice Period"],
  ["notice_period_status", "Notice Period Status"],
  ["exit_status", "Exit Status"],
  ["exit_date", "Exit Date"],
  ["exit_reason", "Exit Reason"],
  ["skills", "Skills"],
  ["notes", "Notes"],
  ["bank_account_holder_name", "Bank Account Holder Name"],
  ["bank_name", "Bank Name"],
  ["bank_account_number", "Bank Account Number"],
  ["bank_ifsc_code", "IFSC Code"],
  ["bank_branch", "Bank Branch"],
  ["bank_account_type", "Account Type (Savings/Current)"],
  ["bank_swift_code", "SWIFT Code"],
  ["bank_pan_number", "PAN Number"],
  ["bank_upi_id", "UPI ID"],
] as const;

function toFormState(employee: Record<string, any> | null): Record<string, string> {
  if (!employee) return {};
  const state: Record<string, string> = {};
  for (const [key, label] of fields) {
    void label;
    const value = employee[key];
    if (value === null || value === undefined) continue;
    state[key] = key.includes("date") || key === "dob" ? String(value).slice(0, 10) : String(value);
  }
  if (employee.photo_url) state.photo_url = String(employee.photo_url);
  return state;
}

function EmployeeDialog({
  onSaved,
  employee = null,
  open,
  onOpenChange,
  trigger = true,
}: {
  onSaved: () => void;
  employee?: Record<string, any> | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: boolean;
}) {
  const isEdit = Boolean(employee);
  const [internalOpen, setInternalOpen] = useState(false);
  const dialogOpen = open ?? internalOpen;
  const setDialogOpen = onOpenChange ?? setInternalOpen;
  const [form, setForm] = useState<Record<string, string>>(() => toFormState(employee));
  const [seededId, setSeededId] = useState<any>(employee?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");
  // Re-seed the form whenever a different employee is opened for editing.
  if (isEdit && employee && employee.id !== seededId) {
    setSeededId(employee.id);
    setForm(toFormState(employee));
  }
  async function uploadPhoto(file: File) {
    setPhotoError("");
    if (!file.type.startsWith("image/")) {
      setPhotoError("Please select an image file");
      return;
    }
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/email-attachments", { method: "POST", body: fd });
    setUploading(false);
    if (r.ok) {
      const d = await r.json();
      setForm((f) => ({ ...f, photo_url: d.pathname }));
    } else {
      const d = await r.json().catch(() => ({}));
      setPhotoError(d.error || "Upload failed");
    }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const r = await fetch(isEdit ? `/api/hr/employees/${employee!.id}` : "/api/hr/employees", {
      method: isEdit ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (r.ok) {
      setDialogOpen(false);
      if (!isEdit) setForm({});
      toast.success(isEdit ? "Employee updated" : "Employee added");
      onSaved();
    } else {
      const d = await r.json().catch(() => ({}));
      toast.error(d.error || "Something went wrong");
    }
  }
  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      {trigger && (
        <DialogTrigger>
          <Plus /> Add employee
        </DialogTrigger>
      )}
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${employee?.employee_name || "employee"}` : "Add employee"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="photo_url">Employee Photo</Label>
            <div className="flex items-center gap-4">
              <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-muted">
                {form.photo_url ? (
                  <img
                    src={form.photo_url || "/placeholder.svg"}
                    alt="Employee photo preview"
                    className="size-full object-cover"
                  />
                ) : (
                  <Users2 className="size-8 text-muted-foreground" />
                )}
              </div>
              <div className="grid gap-1">
                <Input
                  id="photo_url"
                  type="file"
                  accept="image/*"
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadPhoto(f);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {uploading ? (
                    "Uploading…"
                  ) : photoError ? (
                    <span className="text-destructive">{photoError}</span>
                  ) : (
                    "PNG, JPG, WEBP or GIF up to 10MB"
                  )}
                </p>
              </div>
            </div>
          </div>
          {fields.map(([key, label]) => (
            <div key={key} className="grid gap-2">
              <Label htmlFor={key}>
                {label}
                {key === "employee_name" ? " *" : ""}
              </Label>
              <Input
                id={key}
                type={key.includes("date") || key === "dob" ? "date" : "text"}
                required={key === "employee_name"}
                value={form[key] || ""}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </div>
          ))}
          <Button type="submit" disabled={saving || uploading} className="sm:col-span-2">
            {saving ? "Saving…" : "Save employee"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ALL = "__all__";

type Facets = Record<string, string[]>;

function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger size="sm" className="w-[150px]">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SortHeader({
  label,
  column,
  sort,
  dir,
  onSort,
  className,
}: {
  label: string;
  column: string;
  sort: string;
  dir: string;
  onSort: (column: string) => void;
  className?: string;
}) {
  const active = sort === column;
  return (
    <th className={`px-4 py-3 font-medium ${className || ""}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="size-3.5" />
          ) : (
            <ArrowDown className="size-3.5" />
          )
        ) : (
          <ArrowUpDown className="size-3.5 opacity-40" />
        )}
      </button>
    </th>
  );
}

function ImportHistoryDialog() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useSWR<{ runs: any[] }>(open ? "/api/hr/employees/imports" : null, fetcher);
  const runs = data?.runs || [];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <History className="size-4" /> Import history
          </Button>
        }
      />
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import history</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : runs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No imports yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {runs.map((run) => (
              <div key={run.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{run.file_name || "Spreadsheet import"}</span>
                  <span className="text-xs text-muted-foreground">
                    {run.created_at ? new Date(run.created_at).toLocaleString() : ""}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge variant="secondary">{run.total_rows} rows</Badge>
                  <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                    {run.imported} imported
                  </Badge>
                  {run.skipped > 0 && <Badge variant="outline">{run.skipped} skipped</Badge>}
                  {run.failed > 0 && <Badge variant="destructive">{run.failed} failed</Badge>}
                </div>
                {run.actor_name && (
                  <p className="mt-2 text-xs text-muted-foreground">by {run.actor_name}</p>
                )}
                {Array.isArray(run.errors) && run.errors.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      {run.errors.length} message(s)
                    </summary>
                    <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
                      {run.errors.slice(0, 25).map((message: string, index: number) => (
                        <li key={index}>{message}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function EmployeesClient() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [archived, setArchived] = useState<"active" | "archived" | "all">("active");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState("created_at");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const pageSize = 25;
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editEmployee, setEditEmployee] = useState<any>(null);
  const [deleteEmployee, setDeleteEmployee] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);
  const [bulkStatus, setBulkStatus] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  // Debounce the search box so we don't hit the API on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset to the first page whenever the query shape changes.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, archived, filters, sort, dir]);

  const queryString = useMemo(() => {
    const sp = new URLSearchParams();
    if (debouncedSearch) sp.set("q", debouncedSearch);
    sp.set("archived", archived);
    for (const [key, value] of Object.entries(filters)) if (value) sp.set(key, value);
    sp.set("sort", sort);
    sp.set("dir", dir);
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
    return sp.toString();
  }, [debouncedSearch, archived, filters, sort, dir, page]);

  const { data, mutate, isLoading } = useSWR<{
    employees: any[];
    total: number;
    facets: Facets;
  }>(`/api/hr/employees?${queryString}`, fetcher, { keepPreviousData: true });

  const employees = data?.employees || [];
  const total = data?.total || 0;
  const facets = data?.facets || {};
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const activeFilterCount = Object.values(filters).filter(Boolean).length + (debouncedSearch ? 1 : 0);

  function toggleSort(column: string) {
    if (sort === column) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSort(column);
      setDir("asc");
    }
  }

  function setFilter(key: string, value: string) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function clearFilters() {
    setFilters({});
    setSearch("");
    setDebouncedSearch("");
  }

  const pageIds = employees.map((e) => e.id as number);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runBulk(action: string, value?: string) {
    const ids = Array.from(selected);
    if (!ids.length) return;
    setBulkBusy(true);
    const r = await fetch("/api/hr/employees/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, value, ids }),
    });
    setBulkBusy(false);
    if (r.ok) {
      const d = await r.json();
      toast.success(`${d.affected} of ${d.requested} employees updated`);
      setSelected(new Set());
      setBulkStatus("");
      mutate();
    } else {
      const d = await r.json().catch(() => ({}));
      toast.error(d.error || "Bulk action failed");
    }
  }

  async function confirmDelete() {
    if (!deleteEmployee) return;
    setDeleting(true);
    const r = await fetch(`/api/hr/employees/${deleteEmployee.id}`, { method: "DELETE" });
    setDeleting(false);
    if (r.ok) {
      toast.success("Employee deleted");
      setDeleteEmployee(null);
      mutate();
    } else {
      const d = await r.json().catch(() => ({}));
      toast.error(d.error || "Failed to delete employee");
    }
  }

  async function archiveOne(employee: any) {
    const endpoint = employee.archived_at ? "reactivate" : "archive";
    const r = await fetch(`/api/hr/employees/${employee.id}/${endpoint}`, { method: "POST" });
    if (r.ok) {
      toast.success(employee.archived_at ? "Employee reactivated" : "Employee archived");
      mutate();
    } else {
      const d = await r.json().catch(() => ({}));
      toast.error(d.error || "Action failed");
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <Users2 className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Employees</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Complete employee master records and workforce details.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ImportHistoryDialog />
          <ExcelExportButton
            rows={employees}
            filename="employees"
            columns={[
              { header: "Employee ID", value: (r) => r.employee_id },
              { header: "Name", value: (r) => r.employee_name },
              { header: "Gender", value: (r) => r.gender },
              { header: "DOB", value: (r) => r.dob },
              { header: "Personal Email", value: (r) => r.personal_email },
              { header: "Official Email", value: (r) => r.official_email },
              { header: "Mobile", value: (r) => r.mobile },
              { header: "Department", value: (r) => r.department },
              { header: "Designation", value: (r) => r.designation },
              { header: "Reporting Manager", value: (r) => r.reporting_manager },
              { header: "Employment Type", value: (r) => r.employment_type },
              { header: "Joining Date", value: (r) => r.joining_date },
              { header: "Employment Status", value: (r) => r.employment_status },
              { header: "Work Mode", value: (r) => r.work_mode },
              { header: "Work Location", value: (r) => r.work_location },
            ]}
          />
          <ExcelImportButton
            endpoint="/api/hr/employees/import"
            aliases={EMPLOYEE_IMPORT_ALIASES}
            templateFilename="employees-template.xlsx"
            templateHeaders={EMPLOYEE_IMPORT_HEADERS}
            onImported={() => mutate()}
          />
          <EmployeeDialog onSaved={() => mutate()} />
        </div>
      </div>

      {/* Search + scope */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search name, ID, email, mobile, department…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={archived} onValueChange={(v) => setArchived(v as typeof archived)}>
          <SelectTrigger size="sm" className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
            <SelectItem value="all">All records</SelectItem>
          </SelectContent>
        </Select>
        <Badge variant="secondary">{total} employees</Badge>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Filter className="size-4 text-muted-foreground" />
        <FacetSelect
          label="Status"
          value={filters.status || ""}
          options={facets.employment_status || []}
          onChange={(v) => setFilter("status", v)}
        />
        <FacetSelect
          label="Department"
          value={filters.department || ""}
          options={facets.department || []}
          onChange={(v) => setFilter("department", v)}
        />
        <FacetSelect
          label="Designation"
          value={filters.designation || ""}
          options={facets.designation || []}
          onChange={(v) => setFilter("designation", v)}
        />
        <FacetSelect
          label="Type"
          value={filters.employment_type || ""}
          options={facets.employment_type || []}
          onChange={(v) => setFilter("employment_type", v)}
        />
        <FacetSelect
          label="Work mode"
          value={filters.work_mode || ""}
          options={facets.work_mode || []}
          onChange={(v) => setFilter("work_mode", v)}
        />
        {activeFilterCount > 0 && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="size-4" /> Clear
          </Button>
        )}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/50 px-4 py-3">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <Select
            value={bulkStatus || ALL}
            onValueChange={(v) => {
              if (v === ALL) return;
              setBulkStatus(v);
              runBulk("set_status", v);
            }}
          >
            <SelectTrigger size="sm" className="w-[160px]" disabled={bulkBusy}>
              <SelectValue placeholder="Set status…" />
            </SelectTrigger>
            <SelectContent>
              {(facets.employment_status?.length
                ? facets.employment_status
                : ["Active", "On Leave", "Suspended", "Resigned", "Terminated"]
              ).map((status) => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => runBulk("archive")}>
            <Archive className="size-4" /> Archive
          </Button>
          <Button variant="outline" size="sm" disabled={bulkBusy} onClick={() => runBulk("reactivate")}>
            <ArchiveRestore className="size-4" /> Reactivate
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            <X className="size-4" /> Clear selection
          </Button>
          {bulkBusy && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full min-w-[960px] text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="w-10 px-4 py-3">
                <Checkbox
                  checked={allOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  aria-label="Select all on page"
                />
              </th>
              <SortHeader label="Employee" column="name" sort={sort} dir={dir} onSort={toggleSort} />
              <th className="px-4 py-3 font-medium">Contact</th>
              <SortHeader label="Department" column="department" sort={sort} dir={dir} onSort={toggleSort} />
              <SortHeader label="Joined" column="joining_date" sort={sort} dir={dir} onSort={toggleSort} />
              <th className="px-4 py-3 font-medium">Work</th>
              <SortHeader
                label="Status"
                column="employment_status"
                sort={sort}
                dir={dir}
                onSort={toggleSort}
              />
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="border-b last:border-0" data-state={selected.has(e.id) ? "selected" : undefined}>
                <td className="px-4 py-4">
                  <Checkbox
                    checked={selected.has(e.id)}
                    onCheckedChange={() => toggleSelect(e.id)}
                    aria-label={`Select ${e.employee_name}`}
                  />
                </td>
                <td className="px-4 py-4">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/modules/hr/employees/${e.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {e.employee_name}
                    </Link>
                    {e.archived_at && <Badge variant="outline">Archived</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {e.employee_id} · {e.designation || "No designation"}
                  </div>
                </td>
                <td className="px-4 py-4">
                  <div>{e.official_email || e.personal_email || "—"}</div>
                  <div className="text-xs text-muted-foreground">{e.mobile || "No mobile"}</div>
                </td>
                <td className="px-4 py-4">
                  {e.department || "—"}
                  <div className="text-xs text-muted-foreground">Manager: {e.reporting_manager || "—"}</div>
                </td>
                <td className="px-4 py-4">
                  {e.joining_date || "—"}
                  <div className="text-xs text-muted-foreground">{e.employment_type || "—"}</div>
                </td>
                <td className="px-4 py-4">
                  {e.work_mode || "—"}
                  <div className="text-xs text-muted-foreground">{e.work_location || "—"}</div>
                </td>
                <td className="px-4 py-4">
                  <Badge>{e.employment_status || "Active"}</Badge>
                </td>
                <td className="px-4 py-4">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Open ${e.employee_name} profile`}
                      render={<Link href={`/modules/hr/employees/${e.id}`} />}
                    >
                      <ExternalLink className="size-4" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon" aria-label={`More actions for ${e.employee_name}`}>
                            <MoreHorizontal className="size-4" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>{e.employee_name}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setEditEmployee(e)}>
                          <Pencil className="size-4" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          render={<Link href={`/modules/hr/employees/${e.id}?tab=permissions`} />}
                        >
                          <ShieldCheck className="size-4" /> Permissions
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => archiveOne(e)}>
                          {e.archived_at ? (
                            <>
                              <ArchiveRestore className="size-4" /> Reactivate
                            </>
                          ) : (
                            <>
                              <Archive className="size-4" /> Archive
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setDeleteEmployee(e)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="size-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                  {isLoading ? "Loading employees…" : "No employees found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? "No results"
            : `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-4" /> Prev
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Next <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {editEmployee && (
        <EmployeeDialog
          employee={editEmployee}
          trigger={false}
          open={Boolean(editEmployee)}
          onOpenChange={(open) => !open && setEditEmployee(null)}
          onSaved={() => {
            setEditEmployee(null);
            mutate();
          }}
        />
      )}
      <AlertDialog open={Boolean(deleteEmployee)} onOpenChange={(open) => !open && setDeleteEmployee(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete employee?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove {deleteEmployee?.employee_name} ({deleteEmployee?.employee_id}) and their
              master record. This action cannot be undone. Consider archiving instead to keep the record.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
