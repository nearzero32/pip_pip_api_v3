-- Zones are now managed only by SUPER_ADMIN. Keep historical grants, but make
-- every active zones.* grant inert without deleting audit/FK history.
UPDATE account_permission_grants g
SET revoked_at = now(), updated_at = now()
FROM permissions p
WHERE p.id = g.permission_id
  AND p.code IN ('zones.read', 'zones.create', 'zones.update', 'zones.archive', 'zones.export')
  AND g.revoked_at IS NULL;
