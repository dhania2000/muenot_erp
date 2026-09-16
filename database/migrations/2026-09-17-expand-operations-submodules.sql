-- =============================================================================
-- Operations Module — Phase: complete sub-module expansion
-- -----------------------------------------------------------------------------
-- Adds the 25 record tables behind the new hierarchical Operations sidebar.
-- Every table follows the existing operations_* convention:
--   * INT AUTO_INCREMENT primary key `id`
--   * a `status` column (rendered in the generic Operations table view)
--   * `created_by` (used by record-level permission scoping / self-heal)
--   * `created_at` / `updated_at` timestamps
--
-- Safe to run more than once: every statement uses IF NOT EXISTS. No existing
-- Operations table is touched, so current data and pages are preserved.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Projects group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_milestones (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  milestone_name VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  planned_start DATE DEFAULT NULL,
  planned_end DATE DEFAULT NULL,
  actual_start DATE DEFAULT NULL,
  actual_end DATE DEFAULT NULL,
  completion_percent DECIMAL(6,2) DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_deliverables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  deliverable_name VARCHAR(255) DEFAULT NULL,
  milestone_id VARCHAR(191) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  deliverable_type VARCHAR(128) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  submitted_date DATE DEFAULT NULL,
  accepted_date DATE DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  quality_status VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_project_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  document_name VARCHAR(255) DEFAULT NULL,
  document_type VARCHAR(128) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  document_url VARCHAR(512) DEFAULT NULL,
  effective_date DATE DEFAULT NULL,
  expiry_date DATE DEFAULT NULL,
  confidentiality VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Work Management group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  task_title VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  task_type VARCHAR(128) DEFAULT NULL,
  assigned_to VARCHAR(255) DEFAULT NULL,
  reporter VARCHAR(255) DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  start_date DATE DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  estimated_hours DECIMAL(8,2) DEFAULT NULL,
  actual_hours DECIMAL(8,2) DEFAULT NULL,
  completion_percent DECIMAL(6,2) DEFAULT NULL,
  board_stage VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_work_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  work_order_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  work_type VARCHAR(128) DEFAULT NULL,
  assigned_to VARCHAR(255) DEFAULT NULL,
  requested_by VARCHAR(255) DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  start_date DATE DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  estimated_cost DECIMAL(14,2) DEFAULT NULL,
  actual_cost DECIMAL(14,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Resources group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_resource_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  requested_by VARCHAR(255) DEFAULT NULL,
  resource_type VARCHAR(128) DEFAULT NULL,
  skill_category VARCHAR(128) DEFAULT NULL,
  required_skills VARCHAR(512) DEFAULT NULL,
  quantity INT DEFAULT NULL,
  allocation_percent DECIMAL(6,2) DEFAULT NULL,
  required_from DATE DEFAULT NULL,
  required_to DATE DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  justification TEXT DEFAULT NULL,
  approver VARCHAR(255) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_skill_matrix (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  department VARCHAR(128) DEFAULT NULL,
  skill_category VARCHAR(128) DEFAULT NULL,
  skill_name VARCHAR(255) DEFAULT NULL,
  proficiency_level VARCHAR(64) DEFAULT NULL,
  experience_years DECIMAL(5,1) DEFAULT NULL,
  certification VARCHAR(255) DEFAULT NULL,
  last_assessed DATE DEFAULT NULL,
  assessed_by VARCHAR(255) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_capacity_planning (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period VARCHAR(64) DEFAULT NULL,
  department VARCHAR(128) DEFAULT NULL,
  resource_type VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  planned_capacity DECIMAL(10,2) DEFAULT NULL,
  allocated_capacity DECIMAL(10,2) DEFAULT NULL,
  available_capacity DECIMAL(10,2) DEFAULT NULL,
  demand_forecast DECIMAL(10,2) DEFAULT NULL,
  utilization_target DECIMAL(6,2) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_utilization (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  billable_hours DECIMAL(8,2) DEFAULT NULL,
  non_billable_hours DECIMAL(8,2) DEFAULT NULL,
  available_hours DECIMAL(8,2) DEFAULT NULL,
  utilization_percent DECIMAL(6,2) DEFAULT NULL,
  billable_percent DECIMAL(6,2) DEFAULT NULL,
  target_utilization DECIMAL(6,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Timesheets group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_timesheets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  task_id VARCHAR(191) DEFAULT NULL,
  work_date DATE DEFAULT NULL,
  hours_worked DECIMAL(8,2) DEFAULT NULL,
  billable_hours DECIMAL(8,2) DEFAULT NULL,
  activity_type VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  approved_by VARCHAR(255) DEFAULT NULL,
  approval_status VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Quality & SLA group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_qa_audits (
  id INT AUTO_INCREMENT PRIMARY KEY,
  audit_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  audit_type VARCHAR(128) DEFAULT NULL,
  audit_scope VARCHAR(512) DEFAULT NULL,
  auditor VARCHAR(255) DEFAULT NULL,
  audit_date DATE DEFAULT NULL,
  findings TEXT DEFAULT NULL,
  non_conformities TEXT DEFAULT NULL,
  severity VARCHAR(64) DEFAULT NULL,
  score DECIMAL(6,2) DEFAULT NULL,
  corrective_action_required VARCHAR(64) DEFAULT NULL,
  closure_date DATE DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_sla_monitoring (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  sla_metric VARCHAR(255) DEFAULT NULL,
  sla_target VARCHAR(128) DEFAULT NULL,
  actual_value VARCHAR(128) DEFAULT NULL,
  unit VARCHAR(64) DEFAULT NULL,
  measurement_period VARCHAR(64) DEFAULT NULL,
  breach_count INT DEFAULT NULL,
  penalty DECIMAL(14,2) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  review_date DATE DEFAULT NULL,
  sla_status VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_corrective_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reference_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  source_type VARCHAR(128) DEFAULT NULL,
  issue_summary TEXT DEFAULT NULL,
  root_cause TEXT DEFAULT NULL,
  corrective_action TEXT DEFAULT NULL,
  preventive_action TEXT DEFAULT NULL,
  action_owner VARCHAR(255) DEFAULT NULL,
  target_date DATE DEFAULT NULL,
  closure_date DATE DEFAULT NULL,
  effectiveness VARCHAR(128) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Issues group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_escalations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  escalation_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  raised_by VARCHAR(255) DEFAULT NULL,
  escalation_level VARCHAR(64) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  impact TEXT DEFAULT NULL,
  assigned_to VARCHAR(255) DEFAULT NULL,
  raised_date DATE DEFAULT NULL,
  target_resolution DATE DEFAULT NULL,
  resolution TEXT DEFAULT NULL,
  closure_date DATE DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_root_cause_capa (
  id INT AUTO_INCREMENT PRIMARY KEY,
  reference_no VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  problem_statement TEXT DEFAULT NULL,
  analysis_method VARCHAR(128) DEFAULT NULL,
  root_cause TEXT DEFAULT NULL,
  capa_type VARCHAR(64) DEFAULT NULL,
  corrective_action TEXT DEFAULT NULL,
  preventive_action TEXT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  target_date DATE DEFAULT NULL,
  verification_date DATE DEFAULT NULL,
  effectiveness VARCHAR(128) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Process Management group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_sops (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sop_code VARCHAR(128) DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  department VARCHAR(128) DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  effective_date DATE DEFAULT NULL,
  review_date DATE DEFAULT NULL,
  next_review_date DATE DEFAULT NULL,
  approval_status VARCHAR(64) DEFAULT NULL,
  document_url VARCHAR(512) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_checklists (
  id INT AUTO_INCREMENT PRIMARY KEY,
  checklist_name VARCHAR(255) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  linked_sop VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  total_items INT DEFAULT NULL,
  completed_items INT DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  completion_percent DECIMAL(6,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  approval_no VARCHAR(128) DEFAULT NULL,
  request_type VARCHAR(128) DEFAULT NULL,
  related_to VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  requested_by VARCHAR(255) DEFAULT NULL,
  approver VARCHAR(255) DEFAULT NULL,
  request_date DATE DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  decision VARCHAR(64) DEFAULT NULL,
  decision_date DATE DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Client Operations group
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_client_requirements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  requirement_title VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  requirement_type VARCHAR(128) DEFAULT NULL,
  priority VARCHAR(64) DEFAULT NULL,
  source VARCHAR(128) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  received_date DATE DEFAULT NULL,
  target_date DATE DEFAULT NULL,
  acceptance_criteria TEXT DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_client_deliverables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  deliverable_name VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  deliverable_type VARCHAR(128) DEFAULT NULL,
  owner VARCHAR(255) DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  submitted_date DATE DEFAULT NULL,
  acceptance_date DATE DEFAULT NULL,
  acceptance_status VARCHAR(64) DEFAULT NULL,
  version VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_client_approvals (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  approval_item VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  submitted_to VARCHAR(255) DEFAULT NULL,
  submitted_date DATE DEFAULT NULL,
  approver_name VARCHAR(255) DEFAULT NULL,
  decision VARCHAR(64) DEFAULT NULL,
  decision_date DATE DEFAULT NULL,
  feedback TEXT DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------------
-- Finance group (Operations cost tracking — feeds, never duplicates, Finance)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operations_project_cost (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  cost_category VARCHAR(128) DEFAULT NULL,
  cost_head VARCHAR(128) DEFAULT NULL,
  budgeted_cost DECIMAL(14,2) DEFAULT NULL,
  actual_cost DECIMAL(14,2) DEFAULT NULL,
  committed_cost DECIMAL(14,2) DEFAULT NULL,
  variance DECIMAL(14,2) DEFAULT NULL,
  currency VARCHAR(16) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  cost_date DATE DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_resource_cost (
  id INT AUTO_INCREMENT PRIMARY KEY,
  resource_id VARCHAR(191) DEFAULT NULL,
  resource_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  cost_type VARCHAR(128) DEFAULT NULL,
  rate DECIMAL(14,2) DEFAULT NULL,
  rate_type VARCHAR(64) DEFAULT NULL,
  hours DECIMAL(8,2) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  total_cost DECIMAL(14,2) DEFAULT NULL,
  currency VARCHAR(16) DEFAULT NULL,
  billable VARCHAR(32) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_vendor_cost (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vendor_name VARCHAR(255) DEFAULT NULL,
  project_id VARCHAR(191) DEFAULT NULL,
  service_category VARCHAR(128) DEFAULT NULL,
  po_number VARCHAR(128) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  invoice_amount DECIMAL(14,2) DEFAULT NULL,
  paid_amount DECIMAL(14,2) DEFAULT NULL,
  currency VARCHAR(16) DEFAULT NULL,
  invoice_date DATE DEFAULT NULL,
  due_date DATE DEFAULT NULL,
  payment_status VARCHAR(64) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operations_budget_vs_actual (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id VARCHAR(191) DEFAULT NULL,
  project_name VARCHAR(255) DEFAULT NULL,
  client_name VARCHAR(255) DEFAULT NULL,
  category VARCHAR(128) DEFAULT NULL,
  budget_amount DECIMAL(14,2) DEFAULT NULL,
  actual_amount DECIMAL(14,2) DEFAULT NULL,
  variance DECIMAL(14,2) DEFAULT NULL,
  variance_percent DECIMAL(6,2) DEFAULT NULL,
  period VARCHAR(64) DEFAULT NULL,
  currency VARCHAR(16) DEFAULT NULL,
  forecast_amount DECIMAL(14,2) DEFAULT NULL,
  status VARCHAR(64) DEFAULT NULL,
  remarks TEXT DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
