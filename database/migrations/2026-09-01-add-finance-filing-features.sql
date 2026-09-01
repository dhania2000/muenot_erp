-- Add Finance filing and reporting features for the Finance dropdown.
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'GST Filing', 'finance.gst_filing', 'Manage GST returns and liabilities', 20 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'TDS Filing', 'finance.tds_filing', 'Manage TDS returns and payments', 21 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Journal Entries', 'finance.journal_entries', 'Create and review journal entries', 22 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'General Ledger', 'finance.general_ledger', 'View general ledger transactions', 23 FROM modules WHERE slug = 'finance';
INSERT IGNORE INTO features (module_id, name, slug, description, sort_order)
SELECT id, 'Financial Reports', 'finance.financial_reports', 'Generate financial reports', 24 FROM modules WHERE slug = 'finance';
