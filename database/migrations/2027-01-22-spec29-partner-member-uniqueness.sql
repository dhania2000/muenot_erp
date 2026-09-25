-- Spec29 (#172) follow-up — one ACTIVE partner membership per user.
-- ---------------------------------------------------------------------------
-- addMember() previously relied on a check-then-insert, which two concurrent
-- grants could race past. This generated column + unique key make the rule
-- DB-enforced. Revoked rows yield NULL and never conflict.
-- The runtime store (lib/partners/store.ts) applies the same change on boot.
--
-- If this fails with a duplicate-key error, find the offending users with:
--   SELECT user_id, COUNT(*) FROM platform_partner_members
--    WHERE status = 'active' GROUP BY user_id HAVING COUNT(*) > 1;
-- and revoke all but one membership before re-running.

ALTER TABLE `platform_partner_members`
  ADD COLUMN `active_user_id` INT UNSIGNED AS (IF(`status` = 'active', `user_id`, NULL)) STORED,
  ADD UNIQUE KEY `uniq_partner_member_active_user` (`active_user_id`);
