"use client";
import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/fetcher";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Search, Users2, ShieldCheck, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PermissionsDialog } from "@/components/admin/permissions-dialog";
import { ExcelImportButton } from "@/components/sales/excel-import-button";

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
export function EmployeesClient() {
  const { data, mutate } = useSWR<{ employees: any[] }>("/api/hr/employees", fetcher);
  const { data: moduleData } = useSWR<{ modules: any[] }>("/api/admin/modules", fetcher);
  const [search, setSearch] = useState("");
  const [permissionEmployee, setPermissionEmployee] = useState<any>(null);
  const [permissionEmployeeId, setPermissionEmployeeId] = useState("");
  const [editEmployee, setEditEmployee] = useState<any>(null);
  const [deleteEmployee, setDeleteEmployee] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);
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
  const employees = (data?.employees || []).filter((e) =>
    `${e.employee_id} ${e.employee_name} ${e.department} ${e.designation} ${e.official_email}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
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
          <ExcelImportButton
            endpoint="/api/hr/employees/import"
            aliases={EMPLOYEE_IMPORT_ALIASES}
            templateFilename="employees-template.xlsx"
            templateHeaders={EMPLOYEE_IMPORT_HEADERS}
            onImported={() => mutate()}
          />
          <EmployeeDialog onSaved={() => mutate()} />
          <select
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={permissionEmployeeId}
            onChange={(e) => setPermissionEmployeeId(e.target.value)}
            aria-label="Select employee for permissions"
          >
            <option value="">Select employee</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.employee_name}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            disabled={!permissionEmployeeId}
            onClick={() => setPermissionEmployee(employees.find((e) => String(e.id) === permissionEmployeeId))}
          >
            <ShieldCheck className="size-4" /> Manage permissions
          </Button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search employees..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Badge variant="secondary">{employees.length} employees</Badge>
      </div>
      <div className="overflow-x-auto rounded-md border bg-card">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {["Employee", "Contact", "Department", "Employment", "Work", "Status"].map((x) => (
                <th key={x} className="px-4 py-3 font-medium">
                  {x}
                </th>
              ))}
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className="border-b last:border-0">
                <td className="px-4 py-4">
                  <div className="font-medium">{e.employee_name}</div>
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
                  {e.employment_type || "—"}
                  <div className="text-xs text-muted-foreground">Joined: {e.joining_date || "—"}</div>
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
                      aria-label={`Edit ${e.employee_name}`}
                      onClick={() => setEditEmployee(e)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${e.employee_name}`}
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteEmployee(e)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                  No employees found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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
              master record. This action cannot be undone.
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
      <PermissionsDialog
        employee={
          permissionEmployee
            ? ({
                id: permissionEmployee.id,
                name: permissionEmployee.employee_name,
                email: permissionEmployee.official_email || permissionEmployee.personal_email || "",
              } as any)
            : null
        }
        modules={moduleData?.modules || []}
        onOpenChange={(open) => !open && setPermissionEmployee(null)}
      />
    </div>
  );
}
