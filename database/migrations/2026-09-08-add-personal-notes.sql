-- Personal notes / daily tasks (Google Keep style).
-- Each note belongs to one user (users.id via session.userId). Employees jot
-- their daily tasks, tick them off when done, and can edit or delete them.
-- The /api/notes route also creates this table on first use, so running this
-- migration by hand is optional.
CREATE TABLE IF NOT EXISTS `personal_notes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` INT NOT NULL,
  `content` TEXT NOT NULL,
  `color` VARCHAR(20) NOT NULL DEFAULT 'default',
  `completed` TINYINT(1) NOT NULL DEFAULT 0,
  `completed_at` DATETIME DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_personal_notes_user` (`user_id`),
  KEY `idx_personal_notes_user_completed` (`user_id`, `completed`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
