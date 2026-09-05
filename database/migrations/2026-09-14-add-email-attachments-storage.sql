-- Stores uploaded email-template attachments directly in the database
-- (the "Email Attachment" folder), so uploads work without external blob storage.
CREATE TABLE IF NOT EXISTS email_attachments (
  id CHAR(36) NOT NULL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  content_type VARCHAR(150) NOT NULL,
  size INT NOT NULL,
  data LONGBLOB NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
