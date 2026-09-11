-- Adds geolocation columns to hr_attendance for existing databases.
-- The original 2026-09-01-add-hr-attendance.sql uses CREATE TABLE IF NOT EXISTS,
-- so tables that already existed before the location feature never received
-- these columns. Run this once against such databases.
--
-- Idempotent: uses ADD COLUMN IF NOT EXISTS so it re-imports cleanly even when
-- the runtime self-heal already created these columns (MariaDB / MySQL 8.0.29+).
ALTER TABLE `hr_attendance` ADD COLUMN IF NOT EXISTS `location` VARCHAR(180) DEFAULT NULL AFTER `overtime_hours`;
ALTER TABLE `hr_attendance` ADD COLUMN IF NOT EXISTS `latitude` DECIMAL(10,7) DEFAULT NULL AFTER `location`;
ALTER TABLE `hr_attendance` ADD COLUMN IF NOT EXISTS `longitude` DECIMAL(10,7) DEFAULT NULL AFTER `latitude`;
