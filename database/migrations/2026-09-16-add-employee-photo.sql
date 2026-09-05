-- Adds an employee photo/picture column to hr_employees.
-- The image itself is stored (DB-backed) via /api/email-attachments and this
-- column holds the returned download pathname (e.g. /api/email-attachments/{id}).
ALTER TABLE hr_employees ADD COLUMN IF NOT EXISTS photo_url VARCHAR(255) NULL;
