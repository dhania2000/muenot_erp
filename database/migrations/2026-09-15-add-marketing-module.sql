-- Marketing module: Campaigns sub-module.
-- Adds the top-level "Marketing" workspace module plus its Campaigns feature
-- slug (marketing.view_campaigns) so it appears in the sidebar and the
-- employee permission matrix.

-- Register the Marketing module (idempotent).
INSERT INTO modules (name, slug, description, icon, sort_order)
SELECT 'Marketing', 'marketing', 'Plan and track marketing campaigns.', 'megaphone', 42
FROM dual
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'marketing');

-- Feature slug used for sidebar + page gating.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Campaigns', 'marketing.view_campaigns', 'View and manage marketing campaigns', 1 FROM modules WHERE slug = 'marketing';

-- Backing table for campaign records.
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(190) NOT NULL,
  channel       VARCHAR(60)  DEFAULT NULL,
  status        VARCHAR(30)  NOT NULL DEFAULT 'Draft',
  budget        DECIMAL(12,2) DEFAULT NULL,
  audience      VARCHAR(190) DEFAULT NULL,
  start_date    DATE         DEFAULT NULL,
  end_date      DATE         DEFAULT NULL,
  notes         TEXT         DEFAULT NULL,
  created_by    INT          DEFAULT NULL,
  assigned_to   INT          DEFAULT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
