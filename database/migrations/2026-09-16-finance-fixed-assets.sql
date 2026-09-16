-- =====================================================================
-- Finance > Fixed Assets sub-module — full schema
-- ---------------------------------------------------------------------
-- Mirrors the self-healing schema the app builds at runtime:
--   * base `fixed_assets` table  -> lib/finance-ensure.ensureRegisterModuleTables
--   * Phase-3 extra columns       -> lib/finance-fixed-assets.ensureFixedAssetSchema
--   * fixed_asset_depreciation    -> per-period depreciation schedule
--   * fixed_asset_transfers       -> custodian / location transfer history
--
-- Idempotent: safe to run on a fresh DB or an existing one (uses
-- CREATE TABLE IF NOT EXISTS). All accounting still flows Journal -> GL
-- through the shared posting engine; these tables only hold the asset
-- master, its depreciation history and its transfer log.
-- MySQL 8 / InnoDB / utf8mb4.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Asset master (base + Phase-3 columns merged into one definition)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_assets (
  id                                INT AUTO_INCREMENT PRIMARY KEY,
  asset_id                          VARCHAR(30)  NOT NULL,
  asset_name                        VARCHAR(255) DEFAULT NULL,
  asset_category                    VARCHAR(80)  DEFAULT NULL,
  acquisition_date                  DATE         DEFAULT NULL,
  financial_year                    VARCHAR(12)  DEFAULT NULL,
  cost                              DECIMAL(16,2) NOT NULL DEFAULT 0,
  funding_source                    VARCHAR(40)  DEFAULT NULL,
  depreciation_method               VARCHAR(40)  DEFAULT NULL,
  useful_life_years                 DECIMAL(6,2) NOT NULL DEFAULT 0,
  salvage_value                     DECIMAL(16,2) NOT NULL DEFAULT 0,
  accumulated_depreciation          DECIMAL(16,2) NOT NULL DEFAULT 0,
  net_book_value                    DECIMAL(16,2) NOT NULL DEFAULT 0,
  location                          VARCHAR(190) DEFAULT NULL,
  custodian                         VARCHAR(190) DEFAULT NULL,
  status                            VARCHAR(30)  NOT NULL DEFAULT 'In Use',
  notes                             TEXT         DEFAULT NULL,

  -- Posting columns (shared voucher engine)
  posting_status                    VARCHAR(20)  NOT NULL DEFAULT 'Unposted',
  voucher_no                        VARCHAR(30)  DEFAULT NULL,
  reversal_voucher_no               VARCHAR(30)  DEFAULT NULL,
  posted_amount                     DECIMAL(16,2) NOT NULL DEFAULT 0,
  posted_snapshot                   LONGTEXT     DEFAULT NULL,
  posted_at                         DATETIME     DEFAULT NULL,

  -- Phase-3 additional columns (ensureFixedAssetSchema)
  asset_type                        VARCHAR(80)  DEFAULT NULL,
  vendor                            VARCHAR(190) DEFAULT NULL,
  purchase_bill                     VARCHAR(60)  DEFAULT NULL,
  purchase_date                     DATE         DEFAULT NULL,
  put_to_use_date                   DATE         DEFAULT NULL,
  quantity                          DECIMAL(14,2) NOT NULL DEFAULT 1,
  gross_cost                        DECIMAL(16,2) NOT NULL DEFAULT 0,
  gst_amount                        DECIMAL(16,2) NOT NULL DEFAULT 0,
  capitalised_cost                  DECIMAL(16,2) NOT NULL DEFAULT 0,
  department                        VARCHAR(120) DEFAULT NULL,
  project                           VARCHAR(120) DEFAULT NULL,
  cost_centre                       VARCHAR(120) DEFAULT NULL,
  depreciation_rate                 DECIMAL(6,2) NOT NULL DEFAULT 0,
  residual_value                    DECIMAL(16,2) NOT NULL DEFAULT 0,
  asset_account                     VARCHAR(40)  DEFAULT NULL,
  accumulated_depreciation_account  VARCHAR(40)  DEFAULT NULL,
  depreciation_expense_account      VARCHAR(40)  DEFAULT NULL,
  documents                         TEXT         DEFAULT NULL,
  capitalised_at                    DATETIME     DEFAULT NULL,
  depreciation_start_date           DATE         DEFAULT NULL,
  last_depreciation_date            DATE         DEFAULT NULL,
  disposal_date                     DATE         DEFAULT NULL,
  disposal_proceeds                 DECIMAL(16,2) NOT NULL DEFAULT 0,
  disposal_mode                     VARCHAR(40)  DEFAULT NULL,
  disposal_voucher_no               VARCHAR(40)  DEFAULT NULL,
  disposal_result                   DECIMAL(16,2) NOT NULL DEFAULT 0,
  archived_at                       DATETIME     DEFAULT NULL,

  created_by                        INT          DEFAULT NULL,
  created_at                        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_fa_id (asset_id),
  KEY idx_fa_fy (financial_year),
  KEY idx_fa_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 2. Per-period depreciation schedule
--    One row per asset + accounting month; the UNIQUE key makes the
--    monthly depreciation run idempotent (a repeat run is a no-op).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  asset_id          VARCHAR(30) NOT NULL,
  period            VARCHAR(7)  NOT NULL,            -- YYYY-MM
  depreciation_date DATE        DEFAULT NULL,
  amount            DECIMAL(16,2) NOT NULL DEFAULT 0,
  method            VARCHAR(40) DEFAULT NULL,
  opening_nbv       DECIMAL(16,2) NOT NULL DEFAULT 0,
  closing_nbv       DECIMAL(16,2) NOT NULL DEFAULT 0,
  voucher_no        VARCHAR(40) DEFAULT NULL,
  financial_year    VARCHAR(12) DEFAULT NULL,
  created_by        INT         DEFAULT NULL,
  created_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fad (asset_id, period),
  KEY idx_fad_asset (asset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------
-- 3. Custodian / location / cost-centre transfer history
--    No accounting impact — a pure movement log.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fixed_asset_transfers (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  asset_id          VARCHAR(30) NOT NULL,
  transfer_date     DATE        DEFAULT NULL,
  from_location     VARCHAR(190) DEFAULT NULL,
  to_location       VARCHAR(190) DEFAULT NULL,
  from_department   VARCHAR(120) DEFAULT NULL,
  to_department     VARCHAR(120) DEFAULT NULL,
  from_cost_centre  VARCHAR(120) DEFAULT NULL,
  to_cost_centre    VARCHAR(120) DEFAULT NULL,
  from_custodian    VARCHAR(190) DEFAULT NULL,
  to_custodian      VARCHAR(190) DEFAULT NULL,
  notes             TEXT        DEFAULT NULL,
  created_by        INT         DEFAULT NULL,
  created_at        DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_fat_asset (asset_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
