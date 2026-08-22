-- SYSTEM migration: make historical Main Category grants inert without deleting history.
UPDATE account_permission_grants g
SET revoked_at = now(), updated_at = now()
FROM permissions p
WHERE p.id = g.permission_id
  AND p.code IN ('main_categories.read', 'main_categories.create', 'main_categories.update', 'main_categories.archive', 'main_categories.export')
  AND g.revoked_at IS NULL;
