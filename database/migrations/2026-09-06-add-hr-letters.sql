-- HR Letter feature (modeled on Worksuite's account/letter screen).
-- Letter templates hold reusable content with {{placeholders}}.
-- Issued letters store a rendered snapshot merged with employee + company data.

CREATE TABLE IF NOT EXISTS `hr_letter_templates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(150) NOT NULL,
  `letter_type` VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
  `subject` VARCHAR(255) NOT NULL,
  `body` LONGTEXT NOT NULL,
  `status` ENUM('Active','Inactive') NOT NULL DEFAULT 'Active',
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_hr_letter_template_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `hr_letters` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `letter_number` VARCHAR(40) NOT NULL,
  `employee_id` INT UNSIGNED NOT NULL,
  `template_id` BIGINT UNSIGNED NULL,
  `letter_type` VARCHAR(80) NOT NULL DEFAULT 'Offer Letter',
  `subject` VARCHAR(255) NOT NULL,
  `body` LONGTEXT NOT NULL,
  `issue_date` DATE NOT NULL,
  `status` ENUM('Draft','Issued') NOT NULL DEFAULT 'Draft',
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_hr_letter_number` (`letter_number`),
  KEY `idx_hr_letters_employee` (`employee_id`),
  KEY `idx_hr_letters_template` (`template_id`),
  CONSTRAINT `fk_hr_letters_employee` FOREIGN KEY (`employee_id`) REFERENCES `hr_employees` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_hr_letters_template` FOREIGN KEY (`template_id`) REFERENCES `hr_letter_templates` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sidebar features (gated by permissions, like the rest of the HR module).
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'HR Letter Templates','hr.view_letter_templates','Create and manage letter templates',32 FROM modules WHERE slug='hr';
INSERT IGNORE INTO features (module_id,name,slug,description,sort_order)
SELECT id,'HR Letters','hr.view_letters','Issue letters to employees',33 FROM modules WHERE slug='hr';
