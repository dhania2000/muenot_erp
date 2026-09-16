-- =============================================================================
-- Operations Module — Work Management connective fields
-- -----------------------------------------------------------------------------
-- Completes the Work Management group by linking Tasks and Work Orders to the
-- existing Operations entities (Client, Resource, Milestone, Task) instead of
-- leaving them as standalone records. No new masters or pipelines are created —
-- these are plain reference columns that point at existing operations_* rows.
--
-- Safe to run more than once: every column uses ADD COLUMN IF NOT EXISTS and no
-- existing column or row is modified, so current Tasks / Work Orders data and
-- pages are fully preserved.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tasks — link to Client, Resource and Milestone (Project, assignee/reporter,
-- priority, dates and status already exist).
-- ---------------------------------------------------------------------------
ALTER TABLE operations_tasks
  ADD COLUMN IF NOT EXISTS client_name VARCHAR(255) DEFAULT NULL AFTER project_name,
  ADD COLUMN IF NOT EXISTS resource_id VARCHAR(191) DEFAULT NULL AFTER assigned_to,
  ADD COLUMN IF NOT EXISTS resource_name VARCHAR(255) DEFAULT NULL AFTER resource_id,
  ADD COLUMN IF NOT EXISTS milestone_id VARCHAR(191) DEFAULT NULL AFTER resource_name,
  ADD COLUMN IF NOT EXISTS milestone_name VARCHAR(255) DEFAULT NULL AFTER milestone_id;

-- ---------------------------------------------------------------------------
-- Work Orders — link to a Task and a Resource, plus free-form Instructions
-- (Project, Client, assignee, requester, dates and status already exist).
-- ---------------------------------------------------------------------------
ALTER TABLE operations_work_orders
  ADD COLUMN IF NOT EXISTS task_id VARCHAR(191) DEFAULT NULL AFTER project_id,
  ADD COLUMN IF NOT EXISTS resource_id VARCHAR(191) DEFAULT NULL AFTER assigned_to,
  ADD COLUMN IF NOT EXISTS resource_name VARCHAR(255) DEFAULT NULL AFTER resource_id,
  ADD COLUMN IF NOT EXISTS instructions TEXT DEFAULT NULL AFTER description;
