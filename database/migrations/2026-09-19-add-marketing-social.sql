-- =============================================================
-- Migration: Marketing > Social Campaigns
-- Run this in phpMyAdmin (Hostinger) after the base schema and the
-- workspace modules migration.
-- Safe to run once. Uses IF NOT EXISTS where possible.
--
-- Covers three things the Social screen needs:
--   1. Connected accounts  -> social_accounts
--      Each platform can hold MANY accounts. `type` distinguishes a
--      brand/company page from an individual employee account. For
--      employee accounts `owner_name`/`owner_user_id` identify who it
--      belongs to.
--   2. Social posts         -> social_posts
--      One row per campaign/post created from the Create wizard.
--      Content, optional image, target brand and status live here.
--   3. Post -> account fan-out -> social_post_accounts
--      Which specific connected accounts a post is published to.
-- =============================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -------------------------------------------------------------
-- Table: social_accounts
-- A connected social handle. `platform` matches the app's platform ids
-- (linkedin, instagram, x, facebook, youtube, threads, tiktok, pinterest).
-- `type` = 'company' for a brand/company page, 'personal' for an
-- individual employee's own account.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `social_accounts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `platform` ENUM('linkedin','instagram','x','facebook','youtube','threads','tiktok','pinterest') NOT NULL,
  `type` ENUM('company','personal') NOT NULL DEFAULT 'company',
  `handle` VARCHAR(190) NOT NULL,
  `display_name` VARCHAR(190) DEFAULT NULL,
  `owner_name` VARCHAR(190) DEFAULT NULL,
  `owner_user_id` INT UNSIGNED DEFAULT NULL,
  `followers` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_connected` BOOLEAN NOT NULL DEFAULT TRUE,
  `connected_by` INT UNSIGNED DEFAULT NULL,
  `connected_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_social_accounts_platform` (`platform`),
  KEY `idx_social_accounts_type` (`type`),
  KEY `idx_social_accounts_owner` (`owner_user_id`),
  CONSTRAINT `fk_social_accounts_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_social_accounts_connected_by` FOREIGN KEY (`connected_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: social_posts
-- One row per post created in the Create wizard. `image_url` holds an
-- optional uploaded image. `brand` is the chosen brand from step 1.
-- `scheduled_at` / `published_at` are set when the post is scheduled or
-- goes live.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `social_posts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `content` TEXT DEFAULT NULL,
  `image_url` VARCHAR(500) DEFAULT NULL,
  `brand` VARCHAR(190) DEFAULT NULL,
  `status` ENUM('Draft','Scheduled','Publishing','Published','Failed') NOT NULL DEFAULT 'Draft',
  `folder` VARCHAR(120) NOT NULL DEFAULT 'Unclassified',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `scheduled_at` DATETIME DEFAULT NULL,
  `published_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_social_posts_status` (`status`),
  KEY `idx_social_posts_created_by` (`created_by`),
  CONSTRAINT `fk_social_posts_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -------------------------------------------------------------
-- Table: social_post_accounts
-- Fan-out: which connected accounts a post targets. Deleting a post or
-- an account removes the link rows. `platform` is denormalised so the
-- target set survives even if the account row is later removed.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `social_post_accounts` (
  `post_id` INT UNSIGNED NOT NULL,
  `account_id` INT UNSIGNED DEFAULT NULL,
  `platform` ENUM('linkedin','instagram','x','facebook','youtube','threads','tiktok','pinterest') NOT NULL,
  `publish_status` ENUM('Pending','Publishing','Published','Failed') NOT NULL DEFAULT 'Pending',
  `external_post_id` VARCHAR(190) DEFAULT NULL,
  `error_message` VARCHAR(500) DEFAULT NULL,
  `published_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`post_id`, `platform`, `account_id`),
  KEY `idx_spa_account` (`account_id`),
  CONSTRAINT `fk_spa_post` FOREIGN KEY (`post_id`) REFERENCES `social_posts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_spa_account` FOREIGN KEY (`account_id`) REFERENCES `social_accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- -------------------------------------------------------------
-- Features (permissions) attached to the marketing module.
-- Mirrors how the recruitment / messaging migrations register features.
-- -------------------------------------------------------------
INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT id, 'Social Campaigns', 'marketing.social.view', 'View social campaigns and posts', 60
FROM `modules` WHERE `slug` = 'marketing'
  AND NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'marketing.social.view');

INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT id, 'Create Social Posts', 'marketing.social.create', 'Create and publish social posts', 61
FROM `modules` WHERE `slug` = 'marketing'
  AND NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'marketing.social.create');

INSERT INTO `features` (`module_id`, `name`, `slug`, `description`, `sort_order`)
SELECT id, 'Connect Social Accounts', 'marketing.social.connect_accounts', 'Connect company pages and employee accounts', 62
FROM `modules` WHERE `slug` = 'marketing'
  AND NOT EXISTS (SELECT 1 FROM `features` WHERE `slug` = 'marketing.social.connect_accounts');

-- -------------------------------------------------------------
-- Optional seed data mirroring the app's demo state.
-- Comment out if you don't want demo rows.
-- -------------------------------------------------------------
INSERT INTO `social_accounts` (`platform`, `type`, `handle`, `owner_name`, `followers`, `connected_at`) VALUES
  ('linkedin',  'company',  '@muenot',          NULL,           12400, '2026-08-02 00:00:00'),
  ('instagram', 'company',  '@muenot.official', NULL,            8600, '2026-08-10 00:00:00'),
  ('x',         'company',  '@muenot',          NULL,            5200, '2026-08-14 00:00:00'),
  ('linkedin',  'personal', '@priya.sharma',    'Priya Sharma',  3200, '2026-08-20 00:00:00');
