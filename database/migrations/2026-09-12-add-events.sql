CREATE TABLE IF NOT EXISTS `hr_events` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(200) NOT NULL,
  `label_color` VARCHAR(20) DEFAULT '#4f46e5',
  `location` VARCHAR(255) DEFAULT NULL,
  `description` TEXT DEFAULT NULL,
  `start_at` DATETIME NOT NULL,
  `end_at` DATETIME NOT NULL,
  `repeat_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  `repeat_cycle` VARCHAR(20) DEFAULT 'week',
  `repeat_every` INT UNSIGNED DEFAULT 1,
  `repeat_ends_on` DATE DEFAULT NULL,
  `host_name` VARCHAR(150) DEFAULT NULL,
  `attendee_type` VARCHAR(20) NOT NULL DEFAULT 'all_employees',
  `attendees` TEXT DEFAULT NULL,
  `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_by_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_events_start` (`start_at`),
  KEY `idx_events_status` (`status`),
  CONSTRAINT `fk_events_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO modules (name, slug, description, icon, sort_order) SELECT 'Events', 'events', 'Company events, meetings, and gatherings.', 'ticket', 20 FROM dual WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'events');
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Events', 'events.view', 'View events', 1 FROM modules WHERE slug = 'events';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order) SELECT id, 'Manage Events', 'events.manage', 'Create, edit and delete events', 2 FROM modules WHERE slug = 'events';
