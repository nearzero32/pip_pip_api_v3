INSERT INTO "permissions" ("code", "description", "status") VALUES
  ('admins.export', 'تنزيل مديري المدن بصيغة Excel (صلاحية عالمية لـ SUPER_ADMIN)', 'ACTIVE'),
  ('cities.export', 'تنزيل المدن بصيغة Excel (صلاحية عالمية لـ SUPER_ADMIN)', 'ACTIVE'),
  ('delivery_pricing.versions.export', 'تنزيل نسخ تسعير التوصيل بصيغة Excel (صلاحية عالمية لـ SUPER_ADMIN)', 'ACTIVE'),
  ('governorates.export', 'تنزيل المحافظات بصيغة Excel (صلاحية عالمية لـ SUPER_ADMIN)', 'ACTIVE'),
  ('stores.commission.history.export', 'تنزيل تاريخ تغيير نسب استقطاع المتاجر بصيغة Excel', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
