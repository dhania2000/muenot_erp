-- Add employee bank detail columns to hr_employees.
-- Safe to run multiple times: each column is added only if it does not already exist.

ALTER TABLE `hr_employees`
  ADD COLUMN IF NOT EXISTS `bank_account_holder_name` VARCHAR(150) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_name` VARCHAR(150) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_account_number` VARCHAR(50) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_ifsc_code` VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_branch` VARCHAR(150) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_account_type` VARCHAR(40) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_swift_code` VARCHAR(30) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_pan_number` VARCHAR(20) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS `bank_upi_id` VARCHAR(120) DEFAULT NULL;
