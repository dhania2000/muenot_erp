-- Legal module: Contracts and Esign sub-modules.
-- Adds the top-level "Legal" workspace module plus its two feature slugs
-- (legal.view_contracts, legal.view_esign) so it appears in the sidebar and
-- the employee permission matrix.

-- Register the Legal module (idempotent).
INSERT INTO modules (name, slug, description, icon, sort_order)
SELECT 'Legal', 'legal', 'Contracts and e-signature workflows.', 'scale', 41
FROM dual
WHERE NOT EXISTS (SELECT 1 FROM modules WHERE slug = 'legal');

-- Feature slugs used for sidebar + page gating.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Contracts', 'legal.view_contracts', 'View and manage legal contracts', 1 FROM modules WHERE slug = 'legal';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
  SELECT id, 'Esign', 'legal.view_esign', 'View and manage e-signature requests', 2 FROM modules WHERE slug = 'legal';
