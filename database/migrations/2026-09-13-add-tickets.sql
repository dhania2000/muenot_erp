-- Worksuite-style Tickets (helpdesk) feature.
-- Employees with `tickets.view` can raise tickets and see ONLY their own.
-- Management with `tickets.manage` can see ALL tickets, update status, assign agents, reply and delete.

CREATE TABLE IF NOT EXISTS `hr_tickets` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `subject` VARCHAR(255) NOT NULL,
  `description` TEXT DEFAULT NULL,
  `type` VARCHAR(50) NOT NULL DEFAULT 'general',
  `priority` VARCHAR(20) NOT NULL DEFAULT 'medium',
  `status` VARCHAR(20) NOT NULL DEFAULT 'open',
  `requester_name` VARCHAR(150) DEFAULT NULL,
  `requester_email` VARCHAR(190) DEFAULT NULL,
  `agent_name` VARCHAR(150) DEFAULT NULL,
  `created_by` INT UNSIGNED DEFAULT NULL,
  `created_by_name` VARCHAR(150) DEFAULT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_tickets_status` (`status`),
  KEY `idx_tickets_priority` (`priority`),
  KEY `idx_tickets_created_by` (`created_by`),
  CONSTRAINT `fk_tickets_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `hr_ticket_replies` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ticket_id` INT UNSIGNED NOT NULL,
  `message` TEXT NOT NULL,
  `author_id` INT UNSIGNED DEFAULT NULL,
  `author_name` VARCHAR(150) DEFAULT NULL,
  `is_staff` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_ticket_replies_ticket` (`ticket_id`),
  CONSTRAINT `fk_ticket_replies_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `hr_tickets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ensure the Tickets module exists (it may already be registered as a placeholder).
INSERT INTO modules (name, slug, description, icon, sort_order)
SELECT 'Tickets', 'tickets', 'Support requests and helpdesk tickets.', 'ticket-check', 31
FROM dual
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'tickets');

-- Remove the old placeholder features (and any granted permissions) so the permission list stays clean.
DELETE up FROM user_permissions up
  JOIN features f ON f.id = up.feature_id
  JOIN modules m ON m.id = f.module_id
  WHERE m.slug = 'tickets' AND f.slug IN ('tickets.view_dashboard', 'tickets.view_tickets');
DELETE f FROM features f
  JOIN modules m ON m.id = f.module_id
  WHERE m.slug = 'tickets' AND f.slug IN ('tickets.view_dashboard', 'tickets.view_tickets');

-- New permission model.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Raise & View Own Tickets', 'tickets.view', 'Raise tickets and view only your own tickets', 1 FROM modules WHERE slug = 'tickets';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Manage All Tickets', 'tickets.manage', 'View all employees'' tickets, update status, assign agents, reply and delete', 2 FROM modules WHERE slug = 'tickets';
