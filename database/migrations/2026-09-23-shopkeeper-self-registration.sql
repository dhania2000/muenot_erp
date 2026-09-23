-- Pending applications are deliberately separate from active tenants/users.
-- The application email is unique; approval provisions into the existing tenant system.
CREATE TABLE IF NOT EXISTS shopkeeper_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING_APPROVAL',
  business_name VARCHAR(150) NOT NULL,
  business_category VARCHAR(120) NOT NULL,
  owner_name VARCHAR(150) NOT NULL,
  email VARCHAR(190) NOT NULL,
  mobile VARCHAR(40) NOT NULL,
  country VARCHAR(2) NOT NULL,
  state VARCHAR(120) NULL,
  city VARCHAR(120) NOT NULL,
  postal_code VARCHAR(20) NULL,
  password_hash VARCHAR(255) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  terms_accepted_at DATETIME NOT NULL,
  privacy_accepted_at DATETIME NOT NULL,
  tenant_id INT UNSIGNED NULL,
  owner_user_id INT UNSIGNED NULL,
  rejection_reason VARCHAR(500) NULL,
  reviewed_by INT UNSIGNED NULL,
  submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME NULL,
  rejected_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shopkeeper_application_email (email),
  UNIQUE KEY uq_shopkeeper_application_token (token_hash),
  KEY idx_shopkeeper_application_status (status, submitted_at),
  UNIQUE KEY uq_shopkeeper_application_mobile (mobile),
  KEY idx_shopkeeper_application_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shopkeeper_application_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL,
  actor_user_id INT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_shopkeeper_app_event (application_id, created_at),
  CONSTRAINT fk_shopkeeper_app_event FOREIGN KEY (application_id) REFERENCES shopkeeper_applications (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
