-- Upgrade Sales → Forecast into a real CRM forecasting layer.
--
-- The quarterly forecast is now COMPUTED on demand from live Sales records
-- (leads → quotations → contracts) and Finance actuals (sales_invoices), so the
-- legacy `sales_revenue_forecast` table of hand-typed numbers is no longer the
-- source of truth. It is intentionally left in place (untouched) for historical
-- reference and backward compatibility with the sales dashboard.
--
-- The only rows Forecast now persists are manager MANUAL ADJUSTMENTS / TARGETS,
-- kept separate from the system-calculated numbers and always carrying a reason.
-- Codes are allocated race-safely through the shared record_id_sequences table
-- (prefix FA), never via MAX()+1.

CREATE TABLE IF NOT EXISTS `sales_forecast_adjustments` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `adjustment_code` VARCHAR(30) NOT NULL,
  `fy_start_year` SMALLINT UNSIGNED NOT NULL,
  `quarter` TINYINT UNSIGNED NOT NULL,
  `adjustment_type` ENUM('Expected','Best Case','Worst Case','Target') NOT NULL,
  `amount` DECIMAL(14,2) NOT NULL DEFAULT 0,
  `owner_id` INT UNSIGNED DEFAULT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_forecast_adj_code` (`adjustment_code`),
  KEY `idx_forecast_adj_period` (`fy_start_year`, `quarter`),
  KEY `idx_forecast_adj_owner` (`owner_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the FA numbering sequence so the first generated code is FA-0001.
INSERT INTO `record_id_sequences` (`prefix`, `next_number`) VALUES ('FA', 0)
ON DUPLICATE KEY UPDATE `prefix` = VALUES(`prefix`);
