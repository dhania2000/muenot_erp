CREATE TABLE IF NOT EXISTS mobile_whatsapp_onboarding (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash CHAR(64) NOT NULL,
  tenant_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  mobile_session_id VARCHAR(64) NOT NULL,
  signup_state VARCHAR(191) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mobile_wa_launch_token (token_hash),
  UNIQUE KEY uq_mobile_wa_signup_state (signup_state),
  KEY idx_mobile_wa_launch_owner (tenant_id, user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
