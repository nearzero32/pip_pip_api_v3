# Customer Cart test coverage

The numbered rows map directly to the original Cart milestone's minimum integration requirements. Cart-specific coverage is in `test/integration/cart.test.ts`; regression rows name the existing suite that supplies the coverage.

| # | Required behavior | Coverage |
|---:|---|---|
| 1 | Public Catalog anonymous | `public Catalog remains anonymous while Cart requires Customer auth`; `public-catalog.test.ts` |
| 2 | Cart requires Customer auth | `public Catalog remains anonymous while Cart requires Customer auth` |
| 3 | Cart requires City header | `Cart requires X-City-Id` |
| 4 | Customer ownership | `wrong City and wrong Customer cannot expose the Cart` |
| 5 | One active Cart | `adds, prices, merges identical configurations, and enforces one active Cart`; concurrent-first-add tests |
| 6 | One Store | `cross-Store conflict preserves old Cart` |
| 7 | One City | `wrong City and wrong Customer cannot expose the Cart` |
| 8 | Cross-Store conflict preserves Cart | `cross-Store conflict preserves old Cart` |
| 9 | Cross-City cannot bypass scope | `wrong City and wrong Customer cannot expose the Cart`; Size/cross-City and catalog-isolation tests |
| 10 | Atomic Replace succeeds | `atomic replace changes Store and failed replacement preserves it` |
| 11 | Failed Replace preserves Cart | Same test as #10 |
| 12 | Available Product succeeds | `adds, prices, merges identical configurations, and enforces one active Cart` |
| 13 | Unavailable Product fails | `unavailable and cross-Store Products cannot be newly added` |
| 14 | Archived/non-public Product fails | `remaining catalog isolation and lifecycle invalidations are preserved` |
| 15 | Cross-Store Product isolation | `unavailable and cross-Store Products cannot be newly added` |
| 16 | Cross-City Product isolation | `remaining catalog isolation and lifecycle invalidations are preserved` |
| 17 | Quantity integer and positive | `quantity validation rejects zero and over 99`; `client-supplied prices have no authority and non-integer quantities fail` |
| 18 | Quantity maximum | `quantity validation rejects zero and over 99` |
| 19 | PATCH zero is not delete | `quantity validation rejects zero and over 99` |
| 20 | DELETE Item | `delete-last and clear preserve the active Cart` |
| 21 | Delete-last preserves Cart | Same test as #20 |
| 22 | Clear preserves Cart | Same test as #20 |
| 23 | Same Product/config merges | `defaults, modifier pricing, canonical ordering, and distinct configurations`; base and Size merge tests |
| 24 | Different modifiers split Items | `defaults, modifier pricing, canonical ordering, and distinct configurations` |
| 25 | Modifier order canonical | Same test as #24; `valid selected Size controls identity and authoritative pricing` |
| 26 | Invalid Modifier rejected | `invalid, duplicate, over-max, and unavailable Modifier selections are rejected` |
| 27 | Wrong Group/Product Option rejected | `wrong-group and archived Modifier Options cannot bypass validation` |
| 28 | Unavailable Option rejected | `invalid, duplicate, over-max, and unavailable Modifier selections are rejected` |
| 29 | Archived Option rejected | `wrong-group and archived Modifier Options cannot bypass validation` |
| 30 | Modifier defaults | `defaults, modifier pricing, canonical ordering, and distinct configurations` |
| 31 | Modifier maxQuantity | `invalid, duplicate, over-max, and unavailable Modifier selections are rejected` |
| 32 | Modifier pricing | `defaults, modifier pricing, canonical ordering, and distinct configurations` |
| 33 | Client prices ignored | `client-supplied prices have no authority and non-integer quantities fail` |
| 34 | Product + Modifier pricing | `defaults, modifier pricing, canonical ordering, and distinct configurations`; Size pricing test |
| 35 | Quantity multiplication | Same pricing tests as #34 |
| 36 | Cart subtotal | `adds, prices, merges identical configurations, and enforces one active Cart`; multi-line modifier test |
| 37 | Price increase detected | Product price-change test; selected Size price-change test |
| 38 | Price decrease detected | Product price-change test; selected Size price-change test |
| 39 | Current, not snapshot, price returned | Same tests as #37–38 |
| 40 | Unavailable Product retained invalid | `Catalog invalidation preserves an Item and marks it non-orderable` |
| 41 | Unavailable Modifier retained invalid | `existing unavailable Modifier selections remain visible and invalid` |
| 42 | Archived Product retained invalid | `remaining catalog isolation and lifecycle invalidations are preserved` |
| 43 | Hidden Category invalidates Item | Same test as #42 |
| 44 | PAUSED Cart readable | `PAUSED Cart stays readable and rejects every mutation` |
| 45 | PAUSED state exposed | Same test as #44 |
| 46 | PAUSED mutations blocked | Same test as #44 covers add/update/delete/clear/replace |
| 47 | PAUSED is not hidden | Same test as #44; `public-catalog.test.ts` |
| 48 | No delivery fee invented | `Cart totals expose items only and persistence has no expiration` |
| 49 | Empty Cart behavior | never-created not-found test; delete/clear persistent-empty test |
| 50 | No Cart expiration | `Cart totals expose items only and persistence has no expiration` |
| 51 | Concurrent first adds: one Cart | base and Size concurrent-first-add tests |
| 52 | Concurrent identical adds: no duplicate | base and Size concurrent-identical-add tests |
| 53 | Concurrent adds: correct quantity | Same tests as #52 |
| 54 | Concurrent quantity mutations valid | `concurrent absolute quantity updates serialize to one valid state` |
| 55 | Public Catalog regression | `public-catalog.test.ts` and full integration run |
| 56 | Product regression | `products.test.ts` and full integration run |
| 57 | Store Category regression | `store-categories.test.ts` and full integration run |
| 58 | Modifier regression | `modifiers.test.ts` and full integration run |
| 59 | Merchant Catalog regression | `merchant.test.ts` and full integration run |
| 60 | Dashboard Catalog regression | Product, Store Category, Modifier, Store, and Merchant dashboard integration suites |

Additional Size coverage verifies: explicit Size requirement, Product-without-Size behavior, selected Size identity, same/different Size merging, Size/Modifier canonicalization, selected price authority, increase/decrease detection, invalid Size preservation without default fallback, PATCH repair, Size relationship and Store/City isolation, NULL-safe/base identity, and concurrent identical Size additions.
