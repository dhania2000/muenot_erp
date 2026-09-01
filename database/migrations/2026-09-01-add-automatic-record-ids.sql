CREATE TABLE IF NOT EXISTS record_id_sequences (
  prefix VARCHAR(20) NOT NULL PRIMARY KEY,
  next_number INT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO record_id_sequences (prefix, next_number) VALUES
('EMP', 0), ('INV', 0), ('FIN', 0), ('GST', 0), ('TDS', 0), ('JE', 0), ('GL', 0), ('RPT', 0), ('PROJ', 0), ('TKT', 0), ('CLI', 0), ('PROD', 0),
('LEAD', 0), ('COMP', 0), ('MEET', 0), ('QUOTE', 0), ('CONT', 0), ('ONB', 0), ('FORE', 0), ('REG', 0), ('LR', 0), ('DOC', 0), ('SHIFT', 0)
ON DUPLICATE KEY UPDATE prefix = VALUES(prefix);

-- Backfill legacy employee IDs while preserving the internal numeric primary key.
SET @employee_counter := 0;
UPDATE hr_employees
SET employee_id = CONCAT('EMP-', LPAD((@employee_counter := @employee_counter + 1), 4, '0'))
WHERE employee_id IS NULL OR employee_id = '' OR employee_id NOT LIKE 'EMP-%'
ORDER BY id;

UPDATE record_id_sequences
SET next_number = GREATEST(next_number, (SELECT COUNT(*) FROM hr_employees WHERE employee_id LIKE 'EMP-%'))
WHERE prefix = 'EMP';
