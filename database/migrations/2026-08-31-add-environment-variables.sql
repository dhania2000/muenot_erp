CREATE TABLE IF NOT EXISTS `environment_variables` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `category` VARCHAR(80) NOT NULL DEFAULT 'General',
  `value_encrypted` BLOB NOT NULL,
  `is_secret` TINYINT(1) NOT NULL DEFAULT 1,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_environment_variable_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
