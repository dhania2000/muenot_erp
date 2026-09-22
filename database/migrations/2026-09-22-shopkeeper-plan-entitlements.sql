-- =============================================================
-- Shopkeeper plan entitlements
-- =============================================================
-- requireShopkeeperFeature() (lib/shopkeeper.ts) gates EVERY mobile endpoint on
-- two flags: `shopkeeper.mobile_app` plus the per-feature flag. No plan in
-- platform_plans defined any `shopkeeper.*` flag, so every Shopkeeper mobile
-- request returned 403 regardless of plan — the whole mobile API was
-- unreachable in practice.
--
-- This adds a dedicated Shopkeeper plan carrying those flags. It is a separate
-- plan rather than flags bolted onto the ERP plans because a Shopkeeper tenant
-- is a different product with a different price point; granting shop features
-- to every Enterprise tenant would be wrong.
--
-- The flag list mirrors SHOPKEEPER_FEATURES in lib/shopkeeper.ts. Adding a
-- feature there without adding it here silently 403s that endpoint.
--
-- Idempotent: safe to re-run.
-- =============================================================

SET NAMES utf8mb4;

INSERT INTO `platform_plans`
  (`code`, `name`, `description`, `price_monthly`, `currency`, `seat_limit`, `entitlements`, `is_active`, `sort_order`)
VALUES (
  'shopkeeper',
  'Shopkeeper',
  'WhatsApp-first plan for a single shop: inbox, catalogue, orders and customers from the mobile app.',
  499.00,
  'INR',
  5,
  JSON_OBJECT(
    'users', 5,
    'employees', 5,
    'modules', JSON_ARRAY('whatsapp', 'products', 'orders', 'contacts'),
    'storage_gb', 5,
    'automations', 10,
    'integrations', 1,
    'jobs', 1000,
    'reports', 'basic',
    'support_level', 'email',
    'api_calls_per_month', 25000,
    'ai_credits_per_month', 1000,
    'feature_flags', JSON_ARRAY(
      'shopkeeper.mobile_app',
      'shopkeeper.whatsapp',
      'shopkeeper.inbox',
      'shopkeeper.contacts',
      'shopkeeper.templates',
      'shopkeeper.campaigns',
      'shopkeeper.automations',
      'shopkeeper.products',
      'shopkeeper.orders',
      'shopkeeper.team',
      'shopkeeper.notifications',
      'shopkeeper.subscription',
      'shopkeeper.settings'
    )
  ),
  1,
  5
)
ON DUPLICATE KEY UPDATE
  `name` = VALUES(`name`),
  `description` = VALUES(`description`),
  `entitlements` = VALUES(`entitlements`),
  `is_active` = VALUES(`is_active`);
