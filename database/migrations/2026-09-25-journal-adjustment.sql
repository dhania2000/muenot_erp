-- SPEC 165 — Journal Reversal / Adjustment.
--
-- An adjustment / correction / reclassification is a SEPARATE, linked journal
-- that acts on a posted original WITHOUT ever rewriting its history. These two
-- columns carry the back-link on the NEW voucher only:
--   adjustment_of   — the voucher_no of the posted original it acts on.
--   adjustment_type — 'Adjustment' | 'Correction' | 'Reclassification'.
--
-- Reversal keeps using its own reversal_of / reversed_by pair. The engine also
-- adds these columns lazily (ensureManualJournalColumns); this migration keeps
-- the schema explicit and idempotent for fresh databases.

ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS adjustment_of VARCHAR(40) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS adjustment_type VARCHAR(30) DEFAULT NULL;

-- Fast lookup of every adjustment raised against a given original voucher.
CREATE INDEX IF NOT EXISTS idx_journal_entries_adjustment_of
  ON journal_entries (adjustment_of);
