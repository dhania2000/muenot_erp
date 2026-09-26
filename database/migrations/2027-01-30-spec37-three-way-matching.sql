-- Spec37 (#201) — Purchase three-way matching.
--
-- Adds the per-tenant tolerance configuration and the persisted PO ⇄ GRN ⇄
-- vendor-bill match results (with the checker resolution / override audit
-- fields). Reuses the Spec36 procurement tables and the existing purchase_bills
-- master; no order / receipt / invoice subsystem is duplicated.
--
-- Idempotent: safe to re-run. lib/finance-three-way-match-server.ts performs the
-- same CREATE TABLE IF NOT EXISTS steps on demand for unmanaged installs.

CREATE TABLE IF NOT EXISTS finance_match_config (
  tenant_id            INT NOT NULL,
  quantity_percent     DECIMAL(9,2) NOT NULL DEFAULT 0,
  price_percent        DECIMAL(9,2) NOT NULL DEFAULT 0,
  amount_percent       DECIMAL(9,2) NOT NULL DEFAULT 0,
  amount_absolute      DECIMAL(14,2) NOT NULL DEFAULT 1,
  updated_by           INT DEFAULT NULL,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS finance_match_results (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id            INT NOT NULL,
  bill_id              VARCHAR(30) NOT NULL,
  po_number            VARCHAR(30) DEFAULT NULL,
  grn_number           VARCHAR(60) DEFAULT NULL,
  vendor_name          VARCHAR(190) DEFAULT NULL,
  match_status         VARCHAR(30) NOT NULL DEFAULT 'exception',
  payment_hold         TINYINT(1) NOT NULL DEFAULT 0,
  categories           TEXT DEFAULT NULL,
  evidence             MEDIUMTEXT DEFAULT NULL,
  resolution_status    VARCHAR(20) NOT NULL DEFAULT 'open',
  resolution_note      TEXT DEFAULT NULL,
  resolved_by          INT DEFAULT NULL,
  resolved_by_name     VARCHAR(190) DEFAULT NULL,
  resolved_at          DATETIME DEFAULT NULL,
  resolved_categories  TEXT DEFAULT NULL,
  computed_by          INT DEFAULT NULL,
  computed_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_match_tenant_bill (tenant_id, bill_id),
  KEY idx_match_po (tenant_id, po_number),
  KEY idx_match_hold (tenant_id, payment_hold),
  KEY idx_match_status (tenant_id, match_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
