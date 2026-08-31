ALTER TABLE `sales_leads`
  ADD COLUMN `source_url` VARCHAR(500) DEFAULT NULL AFTER `designation`;
