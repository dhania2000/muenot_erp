-- SPEC 159 — Multi-Currency
-- ---------------------------------------------------------------------------
-- Tenant-owned exchange-rate history and FX gain/loss ledger.
--
-- Rate convention: QUOTE -> BASE, i.e. amount_in_base = amount_in_quote * rate.
--   base_currency  = the tenant reporting currency (currency.default_code)
--   quote_currency = the foreign / transaction currency
--
-- Historical rates: one row per (quote, base, date). Conversion "as of" a date
-- always selects the most recent row on or before that date.
--
-- Isolation: both tables are registered tenant-owned (lib/tenant-tables.ts); the
-- application self-heals this schema at runtime (lib/currency/model.ts).

CREATE TABLE IF NOT EXISTS `currency_exchange_rates` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id`      INT UNSIGNED DEFAULT NULL,
  `base_currency`  VARCHAR(3)   NOT NULL,
  `quote_currency` VARCHAR(3)   NOT NULL,
  `rate_date`      DATE         NOT NULL,
  `rate`           DECIMAL(20,10) NOT NULL,
  `source`         ENUM('manual','api','system') NOT NULL DEFAULT 'manual',
  `note`           VARCHAR(255) DEFAULT NULL,
  `created_by`     INT UNSIGNED DEFAULT NULL,
  `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_fx_rate` (`tenant_id`, `quote_currency`, `base_currency`, `rate_date`),
  KEY `idx_fx_rate_lookup` (`tenant_id`, `quote_currency`, `base_currency`, `rate_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `currency_fx_gain_loss` (
  `id`             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id`      INT UNSIGNED DEFAULT NULL,
  `entity_id`      INT UNSIGNED DEFAULT NULL,
  `source_module`  VARCHAR(40)  NOT NULL,
  `source_ref`     VARCHAR(64)  DEFAULT NULL,
  `quote_currency` VARCHAR(3)   NOT NULL,
  `base_currency`  VARCHAR(3)   NOT NULL,
  `txn_amount`     DECIMAL(20,4)  NOT NULL DEFAULT 0,
  `booked_rate`    DECIMAL(20,10) NOT NULL DEFAULT 0,
  `settle_rate`    DECIMAL(20,10) NOT NULL DEFAULT 0,
  `base_booked`    DECIMAL(20,4)  NOT NULL DEFAULT 0,
  `base_settled`   DECIMAL(20,4)  NOT NULL DEFAULT 0,
  `gain_loss`      DECIMAL(20,4)  NOT NULL DEFAULT 0,
  `kind`           ENUM('realized','unrealized') NOT NULL DEFAULT 'realized',
  `as_of_date`     DATE         NOT NULL,
  `notes`          VARCHAR(255) DEFAULT NULL,
  `created_by`     INT UNSIGNED DEFAULT NULL,
  `created_at`     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_fx_gl_source` (`tenant_id`, `source_module`, `source_ref`),
  KEY `idx_fx_gl_date` (`tenant_id`, `as_of_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
