-- =============================================================
-- SPEC 109 — Activity Timeline
-- =============================================================
-- Centralized, append-only activity/event stream tracking:
--   calls | emails | meetings | notes | tasks | status_change | approval
--   | payment | document | system_event
-- Any module writes an activity referencing its subject (customer, lead, deal,
-- invoice, employee, ...). The timeline reads them back ordered by time, scoped
-- by tenant and permission.
--
-- Backing model (tenant-owned; register in lib/tenant-tables.ts):
--   activities             : the event stream.
--   activity_participants  : users/contacts involved in an activity (optional).
-- =============================================================

CREATE TABLE IF NOT EXISTS activities (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  activity_type VARCHAR(30) NOT NULL,
    -- call | email | meeting | note | task | status_change
    -- | approval | payment | document | system_event
  -- What the activity is about (polymorphic subject).
  subject_entity VARCHAR(60) NOT NULL,         -- customer | lead | deal | invoice | employee | ...
  subject_id VARCHAR(64) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT DEFAULT NULL,
  -- Optional secondary link (e.g. an activity on a deal that belongs to a customer).
  related_entity VARCHAR(60) DEFAULT NULL,
  related_id VARCHAR(64) DEFAULT NULL,
  source VARCHAR(30) NOT NULL DEFAULT 'user',  -- user | system | integration | workflow
  direction VARCHAR(10) DEFAULT NULL,          -- inbound | outbound (calls/emails)
  status VARCHAR(30) DEFAULT NULL,             -- for status_change / task activities
  metadata JSON DEFAULT NULL,                  -- type-specific payload
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_id INT DEFAULT NULL,                    -- user who performed it (NULL = system)
  visibility VARCHAR(20) NOT NULL DEFAULT 'internal', -- internal | private | public
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_activities_tenant (tenant_id),
  KEY idx_activities_subject (tenant_id, subject_entity, subject_id, occurred_at),
  KEY idx_activities_related (tenant_id, related_entity, related_id),
  KEY idx_activities_type (tenant_id, activity_type),
  KEY idx_activities_occurred (tenant_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activity_participants (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  activity_id BIGINT NOT NULL,
  participant_type VARCHAR(20) NOT NULL,       -- user | contact
  participant_id VARCHAR(64) NOT NULL,
  role VARCHAR(30) DEFAULT NULL,               -- organizer | attendee | cc | assignee
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_act_part_tenant (tenant_id),
  KEY idx_act_part_activity (activity_id),
  KEY idx_act_part_who (tenant_id, participant_type, participant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
