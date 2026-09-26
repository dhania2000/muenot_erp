-- Spec39 (#223-226): Customer / Vendor / Employee 360 views.
-- The 360 read model only opens anchor records that carry tenant_id, so the
-- two legacy anchors that predate tenancy gain the column here. Existing rows
-- are assigned to the lowest tenant id (the pre-multi-tenant default tenant);
-- review before applying if rows were created for several tenants already.
-- Additive and safe to re-run.

ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS tenant_id INT NULL;
ALTER TABLE customers_vendors ADD COLUMN IF NOT EXISTS tenant_id INT NULL;

UPDATE hr_employees SET tenant_id = (SELECT MIN(id) FROM tenants) WHERE tenant_id IS NULL;
UPDATE customers_vendors SET tenant_id = (SELECT MIN(id) FROM tenants) WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_hr_employees_tenant ON hr_employees (tenant_id, employee_name);
CREATE INDEX IF NOT EXISTS idx_customers_vendors_tenant ON customers_vendors (tenant_id, customer_name);

-- Stable-id join keys used by the 360 sections.
CREATE INDEX IF NOT EXISTS idx_clients_company ON clients (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_purchase_bills_vendor ON purchase_bills (vendor_id);
CREATE INDEX IF NOT EXISTS idx_payments_party ON payments (party_id);
CREATE INDEX IF NOT EXISTS idx_emp_docs_employee ON hr_employee_documents (employee_id);
