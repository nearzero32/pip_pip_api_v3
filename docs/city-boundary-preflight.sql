-- Run before/after deployment; this migration deliberately does not invent data.
-- ACTIVE legacy cities without a boundary remain ACTIVE temporarily, but cannot
-- be re-activated after suspension until their boundary is manually backfilled.
select count(*) as active_cities_missing_boundary
from cities where status = 'ACTIVE' and boundary is null;

select id, name_ar, name_en
from cities where status = 'ACTIVE' and boundary is null
order by name_en, id;

-- Exploratory only: City overlap is permitted by the current product decision.
select count(*) as overlapping_city_pairs
from cities a join cities b on a.id < b.id
where a.boundary is not null and b.boundary is not null
  and ST_Intersects(a.boundary, b.boundary)
  and not ST_Touches(a.boundary, b.boundary);
