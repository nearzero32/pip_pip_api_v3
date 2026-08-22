# Localization foundation

PIP PIP stores translatable system-owned content in one translation table per
resource. This gives every translation a real owner FK, lets PostgreSQL enforce
the resource's scope, and avoids the unsafe `entity_type/entity_id/field`
polymorphic-table pattern. Locale codes live in `supported_locales`; they are
normalized BCP-47-style lower-case tags, not a PostgreSQL enum, so adding `ckb`
later is data plus translations rather than a schema rewrite.

`ar` is the active default RTL locale. `en` is active, required for new
content, and falls back to `ar`. The application validates fallback cycles and
does not permit inactive locales in new writes. A later locale-management phase
may expose administration endpoints; this foundation deliberately does not.

Dashboard writes use a `translations` array and PATCH upserts supplied locales;
omitted translations are retained. Public reads negotiate `Accept-Language`
(q-values, exact locale, base language, configured fallback, then default).
Legacy fixed-language fields remain compatible during the transition but are
not intended to remain authoritative after all route contracts switch.

Cart and Order text is historical evidence. Their localized JSONB snapshot maps
are copied from the active translations at mutation time and never refreshed by
a later catalog rename. Existing scalar snapshots backfill to `{ "ar": value }`;
no English value is invented.

Migrations 0045-0049 are expand/backfill migrations. Migration 0050 makes no
destructive drop because removing old columns is safe only after every API
reader and writer has switched and preflight finds no legacy-only data. Adding
Kurdish later means inserting an active `ckb` registry row, choosing its
fallback/required policy, and adding translation rows; no resource table needs
a new localized column.
