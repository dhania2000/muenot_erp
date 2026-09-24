-- =============================================================================
-- SPEC 112 — MEETING MANAGEMENT
-- =============================================================================
-- A centralized, tenant-scoped meeting engine that unifies scheduling with
-- participants, agenda, attachments, notes, action items, follow-ups and a full
-- change history. It does NOT replace the module-specific `sales_meetings` /
-- `operations_meetings` tables — those remain the source of truth for their
-- module workflows. This is the general cross-module meeting workspace (mirrors
-- the SPEC 110 Task Engine: a top-level module available to every workspace
-- member, isolated per tenant at the data layer).
--
-- Conventions (match spec90 / spec110):
--   * InnoDB / utf8mb4.
--   * Every table is TENANT-OWNED — carries tenant_id and is registered in
--     lib/tenant-tables.ts TENANT_OWNED_TABLES so the isolation guard scopes it.
--   * Child rows carry tenant_id too (denormalized) so guarded queries never
--     need a join back to `meetings` to prove tenancy.
--   * All child tables cascade-delete with their parent meeting.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Core meeting record
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meetings (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id           INT UNSIGNED NOT NULL,
  meeting_code        VARCHAR(30)  DEFAULT NULL,
  title               VARCHAR(200) NOT NULL,
  description         TEXT         DEFAULT NULL,
  meeting_type        ENUM('General','Project','Client','Review','Internal','Interview','Training','One-on-One','Standup','Other')
                        NOT NULL DEFAULT 'General',
  status              ENUM('Scheduled','In Progress','Completed','Cancelled','Rescheduled')
                        NOT NULL DEFAULT 'Scheduled',
  start_time          DATETIME     NOT NULL,
  end_time            DATETIME     NOT NULL,
  timezone            VARCHAR(64)  NOT NULL DEFAULT 'Asia/Kolkata',
  location            VARCHAR(255) DEFAULT NULL,
  is_online           TINYINT(1)   NOT NULL DEFAULT 0,
  meeting_link        VARCHAR(512) DEFAULT NULL,
  -- Optional link back to any ERP record this meeting is about.
  related_entity_type VARCHAR(60)  DEFAULT NULL,
  related_entity_id   VARCHAR(60)  DEFAULT NULL,
  organizer_id        INT UNSIGNED DEFAULT NULL,
  organizer_name      VARCHAR(150) DEFAULT NULL,
  -- Google Calendar linkage (same plumbing as sales/operations meetings).
  google_event_id     VARCHAR(255) DEFAULT NULL,
  meet_link           VARCHAR(512) DEFAULT NULL,
  html_link           VARCHAR(512) DEFAULT NULL,
  created_by          INT UNSIGNED DEFAULT NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_meetings_tenant_code (tenant_id, meeting_code),
  KEY idx_meetings_tenant_start (tenant_id, start_time),
  KEY idx_meetings_tenant_status (tenant_id, status),
  KEY idx_meetings_organizer (tenant_id, organizer_id),
  KEY idx_meetings_related (tenant_id, related_entity_type, related_entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Participants
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_participants (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id        INT UNSIGNED NOT NULL,
  meeting_id       INT UNSIGNED NOT NULL,
  user_id          INT UNSIGNED DEFAULT NULL,
  name             VARCHAR(150) DEFAULT NULL,
  email            VARCHAR(190) DEFAULT NULL,
  participant_role ENUM('Organizer','Required','Optional') NOT NULL DEFAULT 'Required',
  response_status  ENUM('Pending','Accepted','Declined','Tentative') NOT NULL DEFAULT 'Pending',
  attended         TINYINT(1)   NOT NULL DEFAULT 0,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mp_meeting (meeting_id),
  KEY idx_mp_tenant_user (tenant_id, user_id),
  CONSTRAINT fk_mp_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Agenda items (ordered)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_agenda_items (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id        INT UNSIGNED NOT NULL,
  meeting_id       INT UNSIGNED NOT NULL,
  position         INT UNSIGNED NOT NULL DEFAULT 0,
  title            VARCHAR(255) NOT NULL,
  description      TEXT         DEFAULT NULL,
  presenter        VARCHAR(150) DEFAULT NULL,
  duration_minutes INT UNSIGNED DEFAULT NULL,
  is_discussed     TINYINT(1)   NOT NULL DEFAULT 0,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_agenda_meeting (meeting_id, position),
  CONSTRAINT fk_agenda_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Attachments (metadata; bytes live in object storage / blob)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_attachments (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id    INT UNSIGNED NOT NULL,
  meeting_id   INT UNSIGNED NOT NULL,
  file_name    VARCHAR(255) NOT NULL,
  file_url     VARCHAR(1024) NOT NULL,
  file_type    VARCHAR(120) DEFAULT NULL,
  file_size    INT UNSIGNED DEFAULT NULL,
  uploaded_by  INT UNSIGNED DEFAULT NULL,
  uploaded_by_name VARCHAR(150) DEFAULT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_att_meeting (meeting_id),
  CONSTRAINT fk_att_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Notes / minutes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_notes (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id    INT UNSIGNED NOT NULL,
  meeting_id   INT UNSIGNED NOT NULL,
  content      TEXT         NOT NULL,
  author_id    INT UNSIGNED DEFAULT NULL,
  author_name  VARCHAR(150) DEFAULT NULL,
  is_private   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notes_meeting (meeting_id),
  CONSTRAINT fk_notes_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Action items — optionally promoted into the SPEC 110 `tasks` table via task_id
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_action_items (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id      INT UNSIGNED NOT NULL,
  meeting_id     INT UNSIGNED NOT NULL,
  title          VARCHAR(255) NOT NULL,
  description    TEXT         DEFAULT NULL,
  assignee_id    INT UNSIGNED DEFAULT NULL,
  assignee_name  VARCHAR(150) DEFAULT NULL,
  due_date       DATE         DEFAULT NULL,
  priority       ENUM('low','medium','high','urgent') NOT NULL DEFAULT 'medium',
  status         ENUM('open','in_progress','done','cancelled') NOT NULL DEFAULT 'open',
  task_id        INT UNSIGNED DEFAULT NULL,
  completed_at   DATETIME     DEFAULT NULL,
  created_by     INT UNSIGNED DEFAULT NULL,
  created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_meeting (meeting_id),
  KEY idx_ai_tenant_assignee (tenant_id, assignee_id),
  KEY idx_ai_tenant_status (tenant_id, status),
  CONSTRAINT fk_ai_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- Follow-ups — a scheduled next step; may spawn a follow-up meeting
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_followups (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id          INT UNSIGNED NOT NULL,
  meeting_id         INT UNSIGNED NOT NULL,
  followup_type      ENUM('Meeting','Call','Email','Task','Other') NOT NULL DEFAULT 'Meeting',
  scheduled_at       DATETIME     DEFAULT NULL,
  notes              TEXT         DEFAULT NULL,
  status             ENUM('Pending','Done','Cancelled') NOT NULL DEFAULT 'Pending',
  -- When a follow-up produced another meeting, link it here.
  related_meeting_id INT UNSIGNED DEFAULT NULL,
  created_by         INT UNSIGNED DEFAULT NULL,
  created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_fu_meeting (meeting_id),
  KEY idx_fu_tenant_status (tenant_id, status),
  CONSTRAINT fk_fu_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- History / audit trail — immutable, append-only change log per meeting
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_history (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  meeting_id    INT UNSIGNED NOT NULL,
  action        VARCHAR(60)  NOT NULL,
  field_changed VARCHAR(120) DEFAULT NULL,
  old_value     TEXT         DEFAULT NULL,
  new_value     TEXT         DEFAULT NULL,
  actor_id      INT UNSIGNED DEFAULT NULL,
  actor_name    VARCHAR(150) DEFAULT NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_hist_meeting (meeting_id, created_at),
  CONSTRAINT fk_hist_meeting FOREIGN KEY (meeting_id) REFERENCES meetings (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
