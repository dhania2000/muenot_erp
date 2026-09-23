-- Production push delivery metadata. Existing rows remain valid; device_id is
-- nullable for legacy registrations and is required by the authenticated API.
ALTER TABLE mobile_device_registrations
  ADD COLUMN IF NOT EXISTS device_id VARCHAR(160) NULL AFTER token_encrypted,
  ADD COLUMN IF NOT EXISTS app_version VARCHAR(40) NULL AFTER device_id;

ALTER TABLE mobile_device_registrations
  ADD UNIQUE KEY IF NOT EXISTS uq_mobile_device_installation (tenant_id, user_id, device_id);

-- A native FCM token belongs to one app installation globally. Older
-- provider-neutral registrations could have the same token under more than
-- one tenant, so revoke and erase every duplicate token before enforcing the
-- global invariant. The app will register the token again for its active
-- authenticated tenant.
UPDATE mobile_device_registrations d
JOIN (
  SELECT token_hash FROM (
    SELECT token_hash FROM mobile_device_registrations
    GROUP BY token_hash HAVING COUNT(*) > 1
  ) duplicate_hashes
) duplicates ON duplicates.token_hash = d.token_hash
SET d.enabled = 0,
    d.token_encrypted = '',
    d.token_hash = SHA2(CONCAT('revoked-mobile-device:', d.id), 256);

ALTER TABLE mobile_device_registrations
  ADD UNIQUE KEY IF NOT EXISTS uq_mobile_device_token_hash (token_hash);

-- Credentials are deliberately not stored in this table. Configure FCM service
-- account values in the deployment's encrypted server-side environment store.
