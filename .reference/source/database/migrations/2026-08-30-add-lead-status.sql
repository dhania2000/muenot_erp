-- =============================================================
-- Migration: Add `lead_status` column to sales_leads
-- Run this ONCE on your existing live database (phpMyAdmin -> SQL tab).
-- Safe to run even if some leads already exist — it backfills sensible
-- defaults based on the existing `status` column.
-- =============================================================

ALTER TABLE `sales_leads`
  ADD COLUMN `lead_status` ENUM('Open','Won','Lost','Follow Up') NOT NULL DEFAULT 'Open' AFTER `status`,
  ADD KEY `idx_leads_lead_status` (`lead_status`);

-- Backfill existing rows so leads already marked Won / Lost / Follow Up
-- immediately show up in the correct tab instead of staying in "Lead".
UPDATE `sales_leads` SET `lead_status` = 'Won' WHERE `status` = 'Won';
UPDATE `sales_leads` SET `lead_status` = 'Lost' WHERE `status` = 'Lost';
UPDATE `sales_leads` SET `lead_status` = 'Follow Up' WHERE `status` IN ('Follow Up 1', 'Follow Up 2');
