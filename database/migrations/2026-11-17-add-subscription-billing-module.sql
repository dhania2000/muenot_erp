-- ============================================================================
-- Subscription & Billing module — SPEC 16 → SPEC 25
-- ----------------------------------------------------------------------------
-- This is the persisted, canonical schema for the entire Subscription & Billing
-- module (the "Subscription & Billing" nav group: Subscription Management, Plan
-- Management, Feature Entitlements, Usage Metering, Billing, Payment Gateways,
-- Payment Webhooks, Invoices & Credit Notes, Renewals, Customer Billing Portal).
--
-- Every table below is also self-healed at runtime by the engines in
-- lib/billing/* (each calls CREATE TABLE IF NOT EXISTS on first use). This file
-- mirrors those definitions verbatim so the schema can be provisioned, code-
-- reviewed and version-controlled up front instead of only lazily at runtime.
-- Everything is idempotent (CREATE TABLE IF NOT EXISTS / ON DUPLICATE KEY), so
-- it is safe to run against a fresh DB or one the engines have already touched.
--
-- Tenancy: every operational table carries tenant_id and is filtered through
-- lib/tenant-scope in application code. The plan CATALOGUE (saas_plans) is the
-- one intentional exception — it is a global catalogue shared by all tenants.
-- ============================================================================


-- ============================================================================
-- SPEC 16 — SUBSCRIPTION MANAGEMENT   (lib/billing/subscription-engine.ts)
-- Monthly / yearly / 2-year / 5-year terms; trial → active → past_due →
-- grace → suspended → cancelled → expired lifecycle, plus renewals.
-- ============================================================================

-- Global plan catalogue — shared across every tenant (NOT tenant-scoped).
CREATE TABLE IF NOT EXISTS saas_plans (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  plan_code       VARCHAR(30) NOT NULL,
  name            VARCHAR(150) NOT NULL,
  description     TEXT DEFAULT NULL,
  currency        VARCHAR(10) NOT NULL DEFAULT 'USD',
  price_monthly   DECIMAL(14,2) NOT NULL DEFAULT 0,
  price_yearly    DECIMAL(14,2) NOT NULL DEFAULT 0,
  price_two_year  DECIMAL(14,2) NOT NULL DEFAULT 0,
  price_five_year DECIMAL(14,2) NOT NULL DEFAULT 0,
  trial_days      INT UNSIGNED NOT NULL DEFAULT 0,
  seats           INT UNSIGNED DEFAULT NULL,
  past_due_days   INT UNSIGNED NOT NULL DEFAULT 7,
  grace_days      INT UNSIGNED NOT NULL DEFAULT 14,
  suspend_days    INT UNSIGNED NOT NULL DEFAULT 30,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_public       TINYINT(1) NOT NULL DEFAULT 1,
  created_by      INT UNSIGNED DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saas_plan_code (plan_code),
  KEY idx_saas_plan_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS saas_subscriptions (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscription_no      VARCHAR(30) NOT NULL,
  tenant_id            INT UNSIGNED NOT NULL,
  plan_id              INT UNSIGNED DEFAULT NULL,
  plan_code            VARCHAR(30) DEFAULT NULL,
  plan_name            VARCHAR(150) NOT NULL,
  term                 VARCHAR(20) NOT NULL DEFAULT 'monthly',
  currency             VARCHAR(10) NOT NULL DEFAULT 'USD',
  amount               DECIMAL(14,2) NOT NULL DEFAULT 0,
  seats                INT UNSIGNED DEFAULT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'active',
  auto_renew           TINYINT(1) NOT NULL DEFAULT 1,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  trial_end_date       DATE DEFAULT NULL,
  start_date           DATE NOT NULL,
  current_period_start DATE NOT NULL,
  current_period_end   DATE NOT NULL,
  past_due_days        INT UNSIGNED NOT NULL DEFAULT 7,
  grace_days           INT UNSIGNED NOT NULL DEFAULT 14,
  suspend_days         INT UNSIGNED NOT NULL DEFAULT 30,
  renewal_count        INT UNSIGNED NOT NULL DEFAULT 0,
  last_payment_at      DATETIME DEFAULT NULL,
  canceled_at          DATETIME DEFAULT NULL,
  cancel_reason        VARCHAR(255) DEFAULT NULL,
  ended_at             DATETIME DEFAULT NULL,
  created_by           INT UNSIGNED DEFAULT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_saas_subscription_no (subscription_no),
  KEY idx_saas_subscriptions_tenant (tenant_id),
  KEY idx_saas_sub_status (status),
  KEY idx_saas_sub_period_end (current_period_end)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS saas_subscription_events (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  subscription_id INT UNSIGNED NOT NULL,
  subscription_no VARCHAR(30) DEFAULT NULL,
  event_type      VARCHAR(30) NOT NULL,
  from_status     VARCHAR(20) DEFAULT NULL,
  to_status       VARCHAR(20) DEFAULT NULL,
  amount          DECIMAL(14,2) DEFAULT NULL,
  currency        VARCHAR(10) DEFAULT NULL,
  period_start    DATE DEFAULT NULL,
  period_end      DATE DEFAULT NULL,
  note            VARCHAR(255) DEFAULT NULL,
  actor_id        INT UNSIGNED DEFAULT NULL,
  actor_name      VARCHAR(190) DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_saas_subscription_events_tenant (tenant_id),
  KEY idx_saas_evt_sub (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed the default plan catalogue (idempotent on plan_code). Mirrors
-- seedDefaultPlans() in lib/billing/subscription-engine.ts.
INSERT INTO saas_plans
  (plan_code, name, description, currency, price_monthly, price_yearly, price_two_year, price_five_year,
   trial_days, seats, past_due_days, grace_days, suspend_days, is_active, is_public)
VALUES
  ('PLAN-STARTER',    'Starter',    'For small teams getting started with Muenot ERP.',                         'USD',  29,  290,   522,  1044, 14,   10,  7, 14, 30, 1, 1),
  ('PLAN-GROWTH',     'Growth',     'For scaling SMEs that need the full operations suite.',                     'USD',  99,  990,  1782,  3564, 14,   50,  7, 14, 30, 1, 1),
  ('PLAN-ENTERPRISE', 'Enterprise', 'For enterprises and MNCs with unlimited seats and priority support.',       'USD', 499, 4990,  8982, 17964, 30, NULL, 14, 30, 60, 1, 1)
ON DUPLICATE KEY UPDATE plan_code = plan_code;


-- ============================================================================
-- SPEC 17 — PLAN MANAGEMENT      (entitlements: lib/platform/entitlements.ts)
-- SPEC 18 — FEATURE ENTITLEMENTS (feature map: lib/platform/feature-entitlements.ts)
-- ----------------------------------------------------------------------------
-- The plan ENTITLEMENT contract (modules, users, employees, storage, API /
-- automation / job limits, reports, AI usage, integrations, support level,
-- feature flags) is stored as a JSON document on the platform plan catalogue
-- (`platform_plans.entitlements`), created by the platform-console migrations
-- and self-healed by lib/platform-console.ts. Feature-level states
-- (enabled / disabled / limited / metered) in SPEC 18 are DERIVED at runtime
-- from that JSON by lib/platform/feature-entitlements.ts and enforced
-- server-side by lib/platform/feature-guard.ts + entitlement-guard.ts — they
-- need no table of their own.
--
-- Guarded here so an install predating SPEC 17 gains the column. MySQL has no
-- "ADD COLUMN IF NOT EXISTS", so we add it only when absent.
SET @has_platform_plans := (
  SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'platform_plans'
);
SET @has_entitlements := (
  SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'platform_plans' AND column_name = 'entitlements'
);
SET @sql := IF(@has_platform_plans = 1 AND @has_entitlements = 0,
  'ALTER TABLE `platform_plans` ADD COLUMN `entitlements` JSON DEFAULT NULL',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;


-- ============================================================================
-- SPEC 19 — USAGE METERING       (lib/billing/usage-metering.ts)
-- Per-tenant meters: active users, employees, storage, API requests, emails,
-- notifications, automation runs, jobs, AI usage, documents, bandwidth, etc.
-- ============================================================================

CREATE TABLE IF NOT EXISTS usage_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  meter_key VARCHAR(60) NOT NULL,
  quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  unit VARCHAR(20) NOT NULL DEFAULT 'unit',
  source VARCHAR(60) NULL,
  ref_id VARCHAR(80) NULL,
  metadata JSON NULL,
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_usage_events_meter (tenant_id, meter_key, occurred_at),
  KEY idx_usage_events_time (tenant_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_daily (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  meter_key VARCHAR(60) NOT NULL,
  usage_date DATE NOT NULL,
  quantity DECIMAL(18,4) NOT NULL DEFAULT 0,
  event_count INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usage_daily (tenant_id, meter_key, usage_date),
  KEY idx_usage_daily_lookup (tenant_id, meter_key, usage_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_limits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id INT UNSIGNED NOT NULL,
  meter_key VARCHAR(60) NOT NULL,
  limit_value DECIMAL(18,4) NOT NULL DEFAULT 0,
  period VARCHAR(10) NOT NULL DEFAULT 'month',
  hard_limit TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_usage_limits (tenant_id, meter_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- SPEC 20 — BILLING ENGINE   (lib/billing/billing-engine.ts)
-- SPEC 23 — INVOICING        (invoices + bill_to_* details + credit notes)
-- Recurring & one-time charges, discounts, coupons, taxes, credits,
-- adjustments, refunds, proration, up/downgrade, renewal, invoice generation
-- and payment reconciliation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_coupons (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id        INT UNSIGNED NOT NULL,
  coupon_code      VARCHAR(40) NOT NULL,
  name             VARCHAR(150) NOT NULL,
  discount_type    VARCHAR(10) NOT NULL DEFAULT 'percent',
  value            DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency         VARCHAR(10) NOT NULL DEFAULT 'USD',
  duration         VARCHAR(12) NOT NULL DEFAULT 'once',
  duration_months  INT UNSIGNED DEFAULT NULL,
  min_amount       DECIMAL(14,2) DEFAULT NULL,
  max_redemptions  INT UNSIGNED DEFAULT NULL,
  times_redeemed   INT UNSIGNED NOT NULL DEFAULT 0,
  valid_from       DATE DEFAULT NULL,
  valid_until      DATE DEFAULT NULL,
  is_active        TINYINT(1) NOT NULL DEFAULT 1,
  created_by       INT UNSIGNED DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_coupon_code (tenant_id, coupon_code),
  KEY idx_billing_coupons_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- SPEC 23 invoice header. The bill_to_* / credit_note_of / last_sent_* columns
-- are declared inline here; the engine adds them idempotently on older installs.
CREATE TABLE IF NOT EXISTS billing_invoices (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  invoice_no       VARCHAR(30) NOT NULL,
  tenant_id        INT UNSIGNED NOT NULL,
  subscription_id  INT UNSIGNED DEFAULT NULL,
  customer_name    VARCHAR(190) NOT NULL DEFAULT '',
  invoice_type     VARCHAR(20) NOT NULL DEFAULT 'one_time',
  currency         VARCHAR(10) NOT NULL DEFAULT 'USD',
  subtotal         DECIMAL(14,2) NOT NULL DEFAULT 0,
  discount_total   DECIMAL(14,2) NOT NULL DEFAULT 0,
  coupon_code      VARCHAR(40) DEFAULT NULL,
  tax_rate         DECIMAL(7,4) NOT NULL DEFAULT 0,
  tax_total        DECIMAL(14,2) NOT NULL DEFAULT 0,
  credit_applied   DECIMAL(14,2) NOT NULL DEFAULT 0,
  adjustment_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  total            DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount_paid      DECIMAL(14,2) NOT NULL DEFAULT 0,
  amount_refunded  DECIMAL(14,2) NOT NULL DEFAULT 0,
  balance          DECIMAL(14,2) NOT NULL DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'draft',
  issue_date       DATE NOT NULL,
  due_date         DATE DEFAULT NULL,
  period_start     DATE DEFAULT NULL,
  period_end       DATE DEFAULT NULL,
  memo             VARCHAR(500) DEFAULT NULL,
  bill_to_email    VARCHAR(190) DEFAULT NULL,
  bill_to_company  VARCHAR(190) DEFAULT NULL,
  bill_to_tax_id   VARCHAR(60) DEFAULT NULL,
  bill_to_address  VARCHAR(300) DEFAULT NULL,
  bill_to_city     VARCHAR(120) DEFAULT NULL,
  bill_to_state    VARCHAR(120) DEFAULT NULL,
  bill_to_postal   VARCHAR(30) DEFAULT NULL,
  bill_to_country  VARCHAR(120) DEFAULT NULL,
  credit_note_of   INT UNSIGNED DEFAULT NULL,
  last_sent_at     DATETIME DEFAULT NULL,
  last_sent_to     VARCHAR(190) DEFAULT NULL,
  created_by       INT UNSIGNED DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_invoice_no (invoice_no),
  KEY idx_billing_invoices_tenant (tenant_id),
  KEY idx_billing_inv_status (status),
  KEY idx_billing_inv_sub (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_invoice_lines (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  invoice_id    INT UNSIGNED NOT NULL,
  line_type     VARCHAR(20) NOT NULL DEFAULT 'one_time',
  description   VARCHAR(300) NOT NULL DEFAULT '',
  quantity      DECIMAL(14,4) NOT NULL DEFAULT 1,
  unit_amount   DECIMAL(14,4) NOT NULL DEFAULT 0,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  taxable       TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_billing_lines_tenant (tenant_id),
  KEY idx_billing_lines_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_credits (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  credit_no     VARCHAR(30) NOT NULL,
  entry_type    VARCHAR(12) NOT NULL DEFAULT 'credit',
  reason        VARCHAR(300) NOT NULL DEFAULT '',
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
  invoice_id    INT UNSIGNED DEFAULT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'available',
  created_by    INT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_credit_no (credit_no),
  KEY idx_billing_credits_tenant (tenant_id),
  KEY idx_billing_credits_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_payments (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  payment_no    VARCHAR(30) NOT NULL,
  invoice_id    INT UNSIGNED NOT NULL,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
  method        VARCHAR(20) NOT NULL DEFAULT 'manual',
  gateway       VARCHAR(40) DEFAULT NULL,
  reference     VARCHAR(120) DEFAULT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'succeeded',
  reconciled    TINYINT(1) NOT NULL DEFAULT 0,
  reconciled_at DATETIME DEFAULT NULL,
  paid_at       DATETIME DEFAULT NULL,
  note          VARCHAR(300) DEFAULT NULL,
  created_by    INT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_payment_no (payment_no),
  KEY idx_billing_payments_tenant (tenant_id),
  KEY idx_billing_pay_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_refunds (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  refund_no     VARCHAR(30) NOT NULL,
  invoice_id    INT UNSIGNED NOT NULL,
  payment_id    INT UNSIGNED DEFAULT NULL,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
  reason        VARCHAR(300) DEFAULT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'succeeded',
  refunded_at   DATETIME DEFAULT NULL,
  created_by    INT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_billing_refund_no (refund_no),
  KEY idx_billing_refunds_tenant (tenant_id),
  KEY idx_billing_ref_invoice (invoice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS billing_reconciliation (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     INT UNSIGNED NOT NULL,
  statement_ref VARCHAR(60) NOT NULL,
  gateway       VARCHAR(40) NOT NULL DEFAULT '',
  payout_ref    VARCHAR(120) DEFAULT NULL,
  amount        DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency      VARCHAR(10) NOT NULL DEFAULT 'USD',
  payment_id    INT UNSIGNED DEFAULT NULL,
  invoice_no    VARCHAR(30) DEFAULT NULL,
  status        VARCHAR(12) NOT NULL DEFAULT 'unmatched',
  reconciled_at DATETIME DEFAULT NULL,
  created_by    INT UNSIGNED DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_billing_recon_tenant (tenant_id),
  KEY idx_billing_recon_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- SPEC 21 — PAYMENT GATEWAY ABSTRACTION  (lib/billing/gateways/*)
-- ----------------------------------------------------------------------------
-- The provider abstraction (Razorpay, Stripe, future providers) is a code-level
-- adapter layer — a PaymentGateway interface, per-provider adapters and a
-- registry configured from environment variables (configureGatewaysFromEnv).
-- It deliberately holds NO business data of its own: a payment's chosen
-- provider is recorded on billing_payments.gateway / billing_reconciliation.gateway
-- and its inbound events on billing_gateway_events (SPEC 22 below). No table is
-- required for this spec.
-- ============================================================================


-- ============================================================================
-- SPEC 22 — PAYMENT WEBHOOKS  (lib/billing/gateways/webhook-service.ts)
-- Signature verification, idempotency, event storage, retry handling,
-- duplicate-event prevention, failed-event monitoring and reconciliation.
-- The UNIQUE (tenant_id, gateway, event_id) key is what enforces idempotency /
-- duplicate suppression.
-- ============================================================================

CREATE TABLE IF NOT EXISTS billing_gateway_events (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id    INT UNSIGNED NOT NULL,
  gateway      VARCHAR(40) NOT NULL,
  event_id     VARCHAR(191) NOT NULL,
  event_type   VARCHAR(60) NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'processed',
  effect       VARCHAR(30) DEFAULT NULL,
  attempts     INT UNSIGNED NOT NULL DEFAULT 1,
  signature_ok TINYINT(1) NOT NULL DEFAULT 1,
  invoice_id   INT UNSIGNED DEFAULT NULL,
  payment_id   INT UNSIGNED DEFAULT NULL,
  last_error   VARCHAR(1000) DEFAULT NULL,
  reason       VARCHAR(255) DEFAULT NULL,
  raw          MEDIUMTEXT DEFAULT NULL,
  normalized   MEDIUMTEXT DEFAULT NULL,
  received_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_gw_event (tenant_id, gateway, event_id),
  KEY idx_gw_event_tenant (tenant_id),
  KEY idx_gw_event_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- SPEC 24 — RENEWAL MANAGEMENT  (lib/billing/renewal-engine.ts)
-- Auto-renew, renewal reminders, failed-payment retries, grace periods,
-- suspension, expiry, manual renewal and renewal invoices.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saas_renewal_reminders (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  subscription_id INT UNSIGNED NOT NULL,
  subscription_no VARCHAR(30) DEFAULT NULL,
  reminder_kind   VARCHAR(30) NOT NULL,
  period_end      DATE NOT NULL,
  due_date        DATE NOT NULL,
  channel         VARCHAR(20) NOT NULL DEFAULT 'log',
  status          VARCHAR(20) NOT NULL DEFAULT 'logged',
  recipient       VARCHAR(190) DEFAULT NULL,
  note            VARCHAR(255) DEFAULT NULL,
  sent_at         DATETIME DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_renewal_reminder (tenant_id, subscription_id, reminder_kind, period_end),
  KEY idx_renewal_reminder_tenant (tenant_id),
  KEY idx_renewal_reminder_sub (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS saas_renewal_attempts (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       INT UNSIGNED NOT NULL,
  subscription_id INT UNSIGNED NOT NULL,
  subscription_no VARCHAR(30) DEFAULT NULL,
  attempt_no      INT UNSIGNED NOT NULL DEFAULT 1,
  period_end      DATE NOT NULL,
  scheduled_for   DATE NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'failed',
  amount          DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency        VARCHAR(10) NOT NULL DEFAULT 'USD',
  gateway         VARCHAR(40) DEFAULT NULL,
  invoice_no      VARCHAR(30) DEFAULT NULL,
  error           VARCHAR(255) DEFAULT NULL,
  processed_at    DATETIME DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_renewal_attempt (tenant_id, subscription_id, period_end, attempt_no),
  KEY idx_renewal_attempt_tenant (tenant_id),
  KEY idx_renewal_attempt_sub (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ============================================================================
-- SPEC 25 — CUSTOMER BILLING PORTAL  (app/api/billing/portal + components/billing/customer-portal-console.tsx)
-- ----------------------------------------------------------------------------
-- The tenant-admin portal (current plan, usage, billing cycle, invoices,
-- payment methods, payment history, renewal date, upgrade/downgrade,
-- cancellation, credits) is a READ/aggregate surface over the tables above:
--   • plan / cycle / renewal → saas_subscriptions + saas_plans
--   • usage                  → usage_daily / usage_events / usage_limits
--   • invoices / payments    → billing_invoices / billing_payments
--   • credits                → billing_credits
--   • payment methods        → provider-held (gateway abstraction, SPEC 21)
-- It introduces no tables of its own; all reads are tenant-scoped via billingGuard.
-- ============================================================================
