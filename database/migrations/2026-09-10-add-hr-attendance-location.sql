-- Adds geolocation columns to hr_attendance for existing databases.
-- The original 2026-09-01-add-hr-attendance.sql uses CREATE TABLE IF NOT EXISTS,
-- so tables that already existed before the location feature never received
-- these columns. Run this once against such databases.
--
-- MySQL 8 has no ADD COLUMN IF NOT EXISTS, so if a column already exists the
-- statement errors with "Duplicate column name" — that is safe to ignore.
-- (MariaDB supports IF NOT EXISTS and can be run repeatedly.)

ALTER TABLE `hr_attendance` ADD COLUMN `location` VARCHAR(180) DEFAULT NULL AFTER `overtime_hours`;
ALTER TABLE `hr_attendance` ADD COLUMN `latitude` DECIMAL(10,7) DEFAULT NULL AFTER `location`;
ALTER TABLE `hr_attendance` ADD COLUMN `longitude` DECIMAL(10,7) DEFAULT NULL AFTER `latitude`;
