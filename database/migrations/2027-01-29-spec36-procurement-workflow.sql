-- Spec36 (#200) — Procurement workflow.
-- Canonical DDL for the four procurement documents that lib/finance-procurement.ts
-- otherwise self-heals at runtime. Running this on a managed deploy gives new
-- installs tenant-scoped unique keys + idempotency columns up front, and upgrades
-- installs created by the earlier SPEC-136 DDL (adds tenant_id / idempotency_key,
-- swaps global unique keys for per-tenant ones). Safe to re-run.
--
-- The approval chain reuses the shared Approval Authority engine
-- (database/migrations/2026-09-18-approval-authority.sql); no new approval tables
-- are introduced here.

-- ---------------------------------------------------------------------------
-- 1. Purchase requisitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS procurement_requisitions (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  requisition_id       VARCHAR(30) NOT NULL,
  title                VARCHAR(255) DEFAULT NULL,
  request_date         DATE DEFAULT NULL,
  requested_by         VARCHAR(190) DEFAULT NULL,
  department           VARCHAR(190) DEFAULT NULL,
  priority             VARCHAR(20) DEFAULT NULL,
  required_by_date     DATE DEFAULT NULL,
  financial_year       VARCHAR(12) DEFAULT NULL,
  item_description     TEXT DEFAULT NULL,
  quantity             DECIMAL(16,3) NOT NULL DEFAULT 0,
  uom                  VARCHAR(30) DEFAULT NULL,
  estimated_unit_price DECIMAL(16,2) NOT NULL DEFAULT 0,
  estimated_amount     DECIMAL(16,2) NOT NULL DEFAULT 0,
  currency             VARCHAR(10) DEFAULT NULL,
  cost_center          VARCHAR(190) DEFAULT NULL,
  project_name         VARCHAR(190) DEFAULT NULL,
  budget_reference     VARCHAR(60) DEFAULT NULL,
  justification        TEXT DEFAULT NULL,
  approval_status      VARCHAR(20) NOT NULL DEFAULT 'Draft',
  approved_by          VARCHAR(190) DEFAULT NULL,
  approved_by_user_id  INT DEFAULT NULL,
  approval_date        DATE DEFAULT NULL,
  requisition_status   VARCHAR(20) NOT NULL DEFAULT 'Open',
  notes                TEXT DEFAULT NULL,
  tenant_id            INT DEFAULT NULL,
  idempotency_key      VARCHAR(100) DEFAULT NULL,
  created_by           INT DEFAULT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pr_tenant_id (tenant_id, requisition_id),
  UNIQUE KEY uq_pr_idem (tenant_id, idempotency_key),
  KEY idx_pr_status (approval_status),
  KEY idx_pr_stage (requisition_status),
  KEY idx_pr_budget (budget_reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. Requests for quotation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS procurement_rfqs (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  rfq_id               VARCHAR(30) NOT NULL,
  title                VARCHAR(255) DEFAULT NULL,
  requisition_id       VARCHAR(30) DEFAULT NULL,
  issue_date           DATE DEFAULT NULL,
  due_date             DATE DEFAULT NULL,
  item_description     TEXT DEFAULT NULL,
  quantity             DECIMAL(16,3) NOT NULL DEFAULT 0,
  uom                  VARCHAR(30) DEFAULT NULL,
  vendor_1_name        VARCHAR(190) DEFAULT NULL,
  vendor_1_id          VARCHAR(60) DEFAULT NULL,
  vendor_1_quote       DECIMAL(16,2) NOT NULL DEFAULT 0,
  vendor_2_name        VARCHAR(190) DEFAULT NULL,
  vendor_2_id          VARCHAR(60) DEFAULT NULL,
  vendor_2_quote       DECIMAL(16,2) NOT NULL DEFAULT 0,
  vendor_3_name        VARCHAR(190) DEFAULT NULL,
  vendor_3_id          VARCHAR(60) DEFAULT NULL,
  vendor_3_quote       DECIMAL(16,2) NOT NULL DEFAULT 0,
  selection_method     VARCHAR(30) DEFAULT NULL,
  selected_vendor_name VARCHAR(190) DEFAULT NULL,
  selected_vendor_id   VARCHAR(60) DEFAULT NULL,
  lowest_quote         DECIMAL(16,2) NOT NULL DEFAULT 0,
  highest_quote        DECIMAL(16,2) NOT NULL DEFAULT 0,
  awarded_amount       DECIMAL(16,2) NOT NULL DEFAULT 0,
  estimated_savings    DECIMAL(16,2) NOT NULL DEFAULT 0,
  quote_count          INT NOT NULL DEFAULT 0,
  status               VARCHAR(20) NOT NULL DEFAULT 'Draft',
  awarded_by_user_id   INT DEFAULT NULL,
  notes                TEXT DEFAULT NULL,
  tenant_id            INT DEFAULT NULL,
  idempotency_key      VARCHAR(100) DEFAULT NULL,
  created_by           INT DEFAULT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rfq_tenant_id (tenant_id, rfq_id),
  UNIQUE KEY uq_rfq_idem (tenant_id, idempotency_key),
  KEY idx_rfq_status (status),
  KEY idx_rfq_req (requisition_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 3. Purchase orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS procurement_purchase_orders (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  po_number              VARCHAR(30) NOT NULL,
  vendor_name            VARCHAR(190) DEFAULT NULL,
  vendor_id              VARCHAR(60) DEFAULT NULL,
  order_date             DATE DEFAULT NULL,
  expected_delivery_date DATE DEFAULT NULL,
  rfq_id                 VARCHAR(30) DEFAULT NULL,
  requisition_id         VARCHAR(30) DEFAULT NULL,
  financial_year         VARCHAR(12) DEFAULT NULL,
  item_description       TEXT DEFAULT NULL,
  quantity               DECIMAL(16,3) NOT NULL DEFAULT 0,
  uom                    VARCHAR(30) DEFAULT NULL,
  unit_price             DECIMAL(16,2) NOT NULL DEFAULT 0,
  subtotal               DECIMAL(16,2) NOT NULL DEFAULT 0,
  discount_percent       DECIMAL(9,2) NOT NULL DEFAULT 0,
  discount_amount        DECIMAL(16,2) NOT NULL DEFAULT 0,
  taxable_amount         DECIMAL(16,2) NOT NULL DEFAULT 0,
  gst_rate               DECIMAL(9,2) NOT NULL DEFAULT 0,
  gst_amount             DECIMAL(16,2) NOT NULL DEFAULT 0,
  total_amount           DECIMAL(16,2) NOT NULL DEFAULT 0,
  currency               VARCHAR(10) DEFAULT NULL,
  payment_terms          VARCHAR(190) DEFAULT NULL,
  delivery_terms         VARCHAR(190) DEFAULT NULL,
  approval_status        VARCHAR(20) NOT NULL DEFAULT 'Draft',
  approved_by            VARCHAR(190) DEFAULT NULL,
  approved_by_user_id    INT DEFAULT NULL,
  approval_date          DATE DEFAULT NULL,
  status                 VARCHAR(20) NOT NULL DEFAULT 'Draft',
  notes                  TEXT DEFAULT NULL,
  tenant_id              INT DEFAULT NULL,
  idempotency_key        VARCHAR(100) DEFAULT NULL,
  created_by             INT DEFAULT NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_po_tenant_number (tenant_id, po_number),
  UNIQUE KEY uq_po_idem (tenant_id, idempotency_key),
  KEY idx_po_status (status),
  KEY idx_po_approval (approval_status),
  KEY idx_po_req (requisition_id),
  KEY idx_po_rfq (rfq_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 4. Goods receipts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS procurement_goods_receipts (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  grn_id               VARCHAR(30) NOT NULL,
  po_number            VARCHAR(30) DEFAULT NULL,
  vendor_name          VARCHAR(190) DEFAULT NULL,
  receipt_date         DATE DEFAULT NULL,
  item_description     TEXT DEFAULT NULL,
  uom                  VARCHAR(30) DEFAULT NULL,
  ordered_quantity     DECIMAL(16,3) NOT NULL DEFAULT 0,
  received_quantity    DECIMAL(16,3) NOT NULL DEFAULT 0,
  accepted_quantity    DECIMAL(16,3) NOT NULL DEFAULT 0,
  rejected_quantity    DECIMAL(16,3) NOT NULL DEFAULT 0,
  pending_quantity     DECIMAL(16,3) NOT NULL DEFAULT 0,
  unit_price           DECIMAL(16,2) NOT NULL DEFAULT 0,
  received_value       DECIMAL(16,2) NOT NULL DEFAULT 0,
  quality_status       VARCHAR(20) DEFAULT NULL,
  receipt_status       VARCHAR(20) NOT NULL DEFAULT 'Pending',
  inspection_notes     TEXT DEFAULT NULL,
  tenant_id            INT DEFAULT NULL,
  idempotency_key      VARCHAR(100) DEFAULT NULL,
  created_by           INT DEFAULT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_grn_tenant_id (tenant_id, grn_id),
  UNIQUE KEY uq_grn_idem (tenant_id, idempotency_key),
  KEY idx_grn_po (po_number),
  KEY idx_grn_status (receipt_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
