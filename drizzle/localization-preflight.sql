-- Read-only localization migration report. Run against a copied or temporary DB.
WITH resources(resource, owner_table, translation_table) AS (
  VALUES ('governorates','governorates','governorate_translations'),
         ('cities','cities','city_translations'),
         ('zones','zones','zone_translations'),
         ('main_categories','main_categories','main_category_translations'),
         ('subcategories','subcategories','subcategory_translations'),
         ('stores','stores','store_translations'),
         ('store_categories','store_categories','store_category_translations'),
         ('products','products','product_translations'),
         ('product_sizes','product_sizes','product_size_translations'),
         ('modifier_groups','modifier_groups','modifier_group_translations'),
         ('modifier_options','modifier_options','modifier_option_translations')
)
SELECT * FROM resources ORDER BY resource;

SELECT 'governorates' resource, locale, count(*) translation_count FROM governorate_translations GROUP BY locale
UNION ALL SELECT 'cities', locale, count(*) FROM city_translations GROUP BY locale
UNION ALL SELECT 'zones', locale, count(*) FROM zone_translations GROUP BY locale
UNION ALL SELECT 'main_categories', locale, count(*) FROM main_category_translations GROUP BY locale
UNION ALL SELECT 'products', locale, count(*) FROM product_translations GROUP BY locale
ORDER BY resource, locale;

SELECT 'cart_items_without_map' AS metric, count(*) FROM cart_items WHERE product_name_snapshot_localized IS NULL
UNION ALL SELECT 'order_items_without_map', count(*) FROM order_items WHERE product_name_snapshot_localized IS NULL
UNION ALL SELECT 'replacement_rows_without_map', count(*) FROM order_item_replacements WHERE original_product_name_snapshot_localized IS NULL OR replacement_product_name_snapshot_localized IS NULL;
