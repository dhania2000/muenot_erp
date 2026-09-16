-- Finance :: Related Parties (disclosure master)
-- Mirrors the self-healing definition in lib/finance-ensure.ts so the table
-- exists on a clean database without waiting for the first runtime ensure().
-- Related Parties is a plain master (AS 18 / Ind AS 24 disclosure) and never
-- posts to the register, so it carries no posting columns.

CREATE TABLE IF NOT EXISTS related_parties (
  id                     INT AUTO_INCREMENT PRIMARY KEY,
  party_id               VARCHAR(30) NOT NULL,
  party_name             VARCHAR(255) DEFAULT NULL,
  relationship           VARCHAR(80) DEFAULT NULL,
  pan                    VARCHAR(15) DEFAULT NULL,
  gstin                  VARCHAR(20) DEFAULT NULL,
  nature_of_relationship VARCHAR(255) DEFAULT NULL,
  effective_from         DATE DEFAULT NULL,
  effective_to           DATE DEFAULT NULL,
  opening_balance        DECIMAL(16,2) NOT NULL DEFAULT 0,
  contact_person         VARCHAR(190) DEFAULT NULL,
  email                  VARCHAR(190) DEFAULT NULL,
  phone                  VARCHAR(40) DEFAULT NULL,
  address                TEXT DEFAULT NULL,
  status                 VARCHAR(30) NOT NULL DEFAULT 'Active',
  notes                  TEXT DEFAULT NULL,
  created_by             INT DEFAULT NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rp_id (party_id),
  KEY idx_rp_relationship (relationship),
  KEY idx_rp_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
