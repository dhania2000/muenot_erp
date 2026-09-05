-- Expand Operations module tables with full field sets.
-- Target: Hostinger MySQL. Run ONCE (MySQL does not support ADD COLUMN IF NOT EXISTS).
-- Adds detailed columns for Resources, Projects, Allocations, Quality & SLA Reviews, Issues.

-- ---------------------------------------------------------------------------
-- Resources
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_resources`
  ADD COLUMN `department`          VARCHAR(120)    NULL AFTER `resource_type`,
  ADD COLUMN `designation`         VARCHAR(120)    NULL AFTER `department`,
  ADD COLUMN `skill_category`      VARCHAR(120)    NULL AFTER `designation`,
  ADD COLUMN `primary_skills`      VARCHAR(500)    NULL AFTER `skill_category`,
  ADD COLUMN `secondary_skills`    VARCHAR(500)    NULL AFTER `primary_skills`,
  ADD COLUMN `employment_status`   VARCHAR(60)     NULL AFTER `secondary_skills`,
  ADD COLUMN `joining_date`        DATE            NULL AFTER `employment_status`,
  ADD COLUMN `exit_date`           DATE            NULL AFTER `joining_date`,
  ADD COLUMN `current_location`    VARCHAR(160)    NULL AFTER `exit_date`,
  ADD COLUMN `work_mode`           VARCHAR(40)     NULL AFTER `current_location`,
  ADD COLUMN `availability_status` VARCHAR(60)     NULL AFTER `work_mode`,
  ADD COLUMN `cost_rate`           DECIMAL(12,2)   NULL AFTER `availability_status`,
  ADD COLUMN `rate_type`           VARCHAR(40)     NULL AFTER `cost_rate`,
  ADD COLUMN `reporting_manager`   VARCHAR(160)    NULL AFTER `rate_type`,
  ADD COLUMN `personal_email`      VARCHAR(190)    NULL AFTER `reporting_manager`,
  ADD COLUMN `official_email`      VARCHAR(190)    NULL AFTER `personal_email`,
  ADD COLUMN `contact_mobile`      VARCHAR(40)     NULL AFTER `official_email`,
  ADD COLUMN `vendor_agency`       VARCHAR(160)    NULL AFTER `contact_mobile`,
  ADD COLUMN `shift`               VARCHAR(60)     NULL AFTER `vendor_agency`,
  ADD COLUMN `remarks`             TEXT            NULL AFTER `shift`;

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_projects`
  ADD COLUMN `client_id`            VARCHAR(60)   NULL AFTER `project_id`,
  ADD COLUMN `service_vertical`     VARCHAR(160)  NULL AFTER `project_name`,
  ADD COLUMN `project_type`         VARCHAR(120)  NULL AFTER `service_vertical`,
  ADD COLUMN `project_manager`      VARCHAR(160)  NULL AFTER `project_type`,
  ADD COLUMN `operations_manager`   VARCHAR(160)  NULL AFTER `project_manager`,
  ADD COLUMN `billing_model`        VARCHAR(120)  NULL AFTER `end_date`,
  ADD COLUMN `required_resources`   INT           NULL AFTER `billing_model`,
  ADD COLUMN `allocated_resources`  INT           NULL AFTER `required_resources`,
  ADD COLUMN `resources_deficiency` INT           NULL AFTER `allocated_resources`,
  ADD COLUMN `sla_target`           VARCHAR(160)  NULL AFTER `resources_deficiency`,
  ADD COLUMN `shift`                VARCHAR(60)   NULL AFTER `priority`,
  ADD COLUMN `work_mode`            VARCHAR(40)   NULL AFTER `shift`,
  ADD COLUMN `client_poc`           VARCHAR(160)  NULL AFTER `work_mode`,
  ADD COLUMN `client_email`         VARCHAR(190)  NULL AFTER `client_poc`,
  ADD COLUMN `client_contact`       VARCHAR(60)   NULL AFTER `client_email`,
  ADD COLUMN `remarks`              TEXT          NULL AFTER `description`,
  ADD COLUMN `updated_at`           TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- ---------------------------------------------------------------------------
-- Allocations
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_allocations`
  ADD COLUMN `resource_name`       VARCHAR(160)   NULL AFTER `resource_id`,
  ADD COLUMN `resource_type`       VARCHAR(60)    NULL AFTER `resource_name`,
  ADD COLUMN `client_name`         VARCHAR(190)   NULL AFTER `project_id`,
  ADD COLUMN `role`                VARCHAR(160)   NULL AFTER `client_name`,
  ADD COLUMN `shift`               VARCHAR(60)    NULL AFTER `to_date`,
  ADD COLUMN `working_capacity`    DECIMAL(8,2)   NULL AFTER `shift`,
  ADD COLUMN `allocated_capacity`  DECIMAL(8,2)   NULL AFTER `working_capacity`,
  ADD COLUMN `available_capacity`  DECIMAL(8,2)   NULL AFTER `allocated_capacity`,
  ADD COLUMN `project_manager`     VARCHAR(160)   NULL AFTER `status`,
  ADD COLUMN `operations_manager`  VARCHAR(160)   NULL AFTER `project_manager`,
  ADD COLUMN `remarks`             TEXT           NULL AFTER `notes`,
  ADD COLUMN `updated_at`          TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- ---------------------------------------------------------------------------
-- Quality & SLA Reviews
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_quality_reviews`
  ADD COLUMN `task_id`            VARCHAR(60)    NULL AFTER `review_id`,
  ADD COLUMN `client_name`        VARCHAR(190)   NULL AFTER `project_id`,
  ADD COLUMN `resource_name`      VARCHAR(160)   NULL AFTER `resource_id`,
  ADD COLUMN `resource_type`      VARCHAR(60)    NULL AFTER `resource_name`,
  ADD COLUMN `quality_target`     DECIMAL(5,2)   NULL AFTER `quality_score`,
  ADD COLUMN `error_rate`         DECIMAL(5,2)   NULL AFTER `quality_target`,
  ADD COLUMN `rework_count`       INT            NULL AFTER `error_rate`,
  ADD COLUMN `sla_target`         VARCHAR(160)   NULL AFTER `rework_count`,
  ADD COLUMN `sla_actual`         VARCHAR(160)   NULL AFTER `sla_target`,
  ADD COLUMN `sla_status`         VARCHAR(60)    NULL AFTER `sla_actual`,
  ADD COLUMN `client_escalation`  VARCHAR(120)   NULL AFTER `sla_status`,
  ADD COLUMN `root_cause`         TEXT           NULL AFTER `client_escalation`,
  ADD COLUMN `corrective_action`  TEXT           NULL AFTER `root_cause`,
  ADD COLUMN `action_owner`       VARCHAR(160)   NULL AFTER `corrective_action`,
  ADD COLUMN `action_due_date`    DATE           NULL AFTER `action_owner`,
  ADD COLUMN `closure_date`       DATE           NULL AFTER `action_due_date`,
  ADD COLUMN `updated_at`         TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;

-- ---------------------------------------------------------------------------
-- Issues
-- ---------------------------------------------------------------------------
ALTER TABLE `operations_issues`
  ADD COLUMN `date_reported`      DATE           NULL AFTER `issue_id`,
  ADD COLUMN `client_name`        VARCHAR(190)   NULL AFTER `project_id`,
  ADD COLUMN `issue_type`         VARCHAR(120)   NULL AFTER `client_name`,
  ADD COLUMN `issue_category`     VARCHAR(120)   NULL AFTER `issue_type`,
  ADD COLUMN `impact`             VARCHAR(255)   NULL AFTER `description`,
  ADD COLUMN `reported_by`        VARCHAR(160)   NULL AFTER `impact`,
  ADD COLUMN `root_cause`         TEXT           NULL AFTER `assigned_to`,
  ADD COLUMN `corrective_action`  TEXT           NULL AFTER `root_cause`,
  ADD COLUMN `preventive_action`  TEXT           NULL AFTER `corrective_action`,
  ADD COLUMN `target_date`        DATE           NULL AFTER `preventive_action`,
  ADD COLUMN `closure_date`       DATE           NULL AFTER `target_date`,
  ADD COLUMN `escalation_level`   VARCHAR(60)    NULL AFTER `status`,
  ADD COLUMN `client_impact`      VARCHAR(255)   NULL AFTER `escalation_level`,
  ADD COLUMN `business_impact`    VARCHAR(255)   NULL AFTER `client_impact`,
  ADD COLUMN `updated_at`         TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`;
