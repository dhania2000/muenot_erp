-- Spec38 (#230-233) — Training & policy acknowledgment.
--
-- Mirrors the on-demand DDL in lib/training/store.ts so managed deploys match
-- the runtime schema exactly. Every table is tenant-scoped (registered in
-- lib/tenant-tables.ts) so the fail-closed data-layer guard requires a
-- tenant_id predicate on every statement that touches them.
--
-- Covers:
--   • courses -> modules -> lessons (video/document/text) + quiz questions;
--   • central-storage media references with expiry + access control;
--   • role/employee assignments with started/completed/overdue/score tracking;
--   • per-lesson progress, quiz attempts and issued certificates;
--   • policies with immutable versions and employee acknowledgments (version,
--     time and evidence), replay-safe via a unique key.
--
-- Idempotent: every step is guarded, so it is safe to re-run.

CREATE TABLE IF NOT EXISTS training_courses (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT NOT NULL,
  code           VARCHAR(40)  DEFAULT NULL,
  title          VARCHAR(200) NOT NULL,
  description    TEXT DEFAULT NULL,
  category       VARCHAR(120) DEFAULT NULL,
  roles          JSON DEFAULT NULL,
  pass_score     INT NOT NULL DEFAULT 70,
  due_days       INT DEFAULT NULL,
  active         TINYINT(1) NOT NULL DEFAULT 1,
  created_by     INT DEFAULT NULL,
  created_by_name VARCHAR(150) DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_training_course_code (tenant_id, code),
  KEY idx_training_course_tenant (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_modules (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT NOT NULL,
  course_id   INT NOT NULL,
  title       VARCHAR(200) NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_training_module_course (tenant_id, course_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_lessons (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id        INT NOT NULL,
  course_id        INT NOT NULL,
  module_id        INT DEFAULT NULL,
  title            VARCHAR(200) NOT NULL,
  lesson_type      ENUM('video','document','text') NOT NULL DEFAULT 'text',
  media_id         INT DEFAULT NULL,
  content          MEDIUMTEXT DEFAULT NULL,
  duration_seconds INT NOT NULL DEFAULT 0,
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_training_lesson_course (tenant_id, course_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_quiz_questions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT NOT NULL,
  course_id     INT NOT NULL,
  question      TEXT NOT NULL,
  options       JSON NOT NULL,
  correct_index INT NOT NULL DEFAULT 0,
  points        INT NOT NULL DEFAULT 1,
  sort_order    INT NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_training_quiz_course (tenant_id, course_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_media (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id   INT NOT NULL,
  storage_key VARCHAR(1024) NOT NULL,
  file_name   VARCHAR(255) DEFAULT NULL,
  mime        VARCHAR(150) DEFAULT NULL,
  size        BIGINT NOT NULL DEFAULT 0,
  access      ENUM('assigned','tenant') NOT NULL DEFAULT 'assigned',
  expires_at  DATETIME DEFAULT NULL,
  created_by  INT DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_training_media_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_assignments (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id        INT NOT NULL,
  course_id        INT NOT NULL,
  employee_id      INT NOT NULL,
  employee_name    VARCHAR(190) DEFAULT NULL,
  assigned_role    VARCHAR(120) DEFAULT NULL,
  status           ENUM('assigned','started','completed','overdue') NOT NULL DEFAULT 'assigned',
  due_date         DATE DEFAULT NULL,
  started_at       DATETIME DEFAULT NULL,
  completed_at     DATETIME DEFAULT NULL,
  score            INT DEFAULT NULL,
  passed           TINYINT(1) DEFAULT NULL,
  attempts         INT NOT NULL DEFAULT 0,
  reassigned_count INT NOT NULL DEFAULT 0,
  assigned_by      INT DEFAULT NULL,
  assigned_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  idempotency_key  VARCHAR(80) DEFAULT NULL,
  UNIQUE KEY uq_training_assignment (tenant_id, course_id, employee_id),
  KEY idx_training_assignment_emp (tenant_id, employee_id, status),
  KEY idx_training_assignment_course (tenant_id, course_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_lesson_progress (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT NOT NULL,
  assignment_id INT NOT NULL,
  lesson_id     INT NOT NULL,
  completed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_training_progress (tenant_id, assignment_id, lesson_id),
  KEY idx_training_progress_assignment (tenant_id, assignment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_quiz_attempts (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT NOT NULL,
  assignment_id INT NOT NULL,
  course_id     INT NOT NULL,
  employee_id   INT NOT NULL,
  score         INT NOT NULL DEFAULT 0,
  passed        TINYINT(1) NOT NULL DEFAULT 0,
  answers       JSON DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_training_attempt_assignment (tenant_id, assignment_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_certificates (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id      INT NOT NULL,
  assignment_id  INT NOT NULL,
  course_id      INT NOT NULL,
  employee_id    INT NOT NULL,
  employee_name  VARCHAR(190) DEFAULT NULL,
  course_title   VARCHAR(200) DEFAULT NULL,
  certificate_no VARCHAR(60) NOT NULL,
  score          INT DEFAULT NULL,
  issued_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_training_cert (tenant_id, assignment_id),
  UNIQUE KEY uq_training_cert_no (tenant_id, certificate_no),
  KEY idx_training_cert_emp (tenant_id, employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_policies (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT NOT NULL,
  code            VARCHAR(40) DEFAULT NULL,
  title           VARCHAR(200) NOT NULL,
  category        VARCHAR(120) DEFAULT NULL,
  current_version INT NOT NULL DEFAULT 1,
  active          TINYINT(1) NOT NULL DEFAULT 1,
  created_by      INT DEFAULT NULL,
  created_by_name VARCHAR(150) DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_training_policy_code (tenant_id, code),
  KEY idx_training_policy_tenant (tenant_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_policy_versions (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id        INT NOT NULL,
  policy_id        INT NOT NULL,
  version          INT NOT NULL,
  body             MEDIUMTEXT DEFAULT NULL,
  summary          VARCHAR(600) DEFAULT NULL,
  effective_date   DATE DEFAULT NULL,
  published_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_by     INT DEFAULT NULL,
  published_by_name VARCHAR(150) DEFAULT NULL,
  UNIQUE KEY uq_training_policy_version (tenant_id, policy_id, version),
  KEY idx_training_policy_version (tenant_id, policy_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS training_policy_acknowledgments (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id       INT NOT NULL,
  policy_id       INT NOT NULL,
  version         INT NOT NULL,
  employee_id     INT NOT NULL,
  employee_name   VARCHAR(190) DEFAULT NULL,
  acknowledged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  evidence        JSON DEFAULT NULL,
  idempotency_key VARCHAR(80) DEFAULT NULL,
  UNIQUE KEY uq_training_ack (tenant_id, policy_id, version, employee_id),
  KEY idx_training_ack_emp (tenant_id, employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
