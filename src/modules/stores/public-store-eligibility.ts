import type { SQL } from "bun";

export type PublicEligibleStore={id:string;name:string;orderAcceptanceStatus:"ACCEPTING"|"PAUSED";latitude:number;longitude:number};
export const PUBLIC_STORE_ELIGIBILITY_SQL="s.status = 'ACTIVE' and s.archived_at is null and mc.status = 'ACTIVE' and mc.archived_at is null and logo.status = 'READY' and logo.visibility = 'PUBLIC'";

/** Shared public eligibility predicate: ACTIVE Store/category and READY PUBLIC logo. */
export async function loadPublicEligibleStore(client:SQL,cityId:string,storeId:string):Promise<PublicEligibleStore|null>{
  const rows=await client.unsafe(`select s.id,s.name,s.order_acceptance_status as "orderAcceptanceStatus",ST_Y(s.location)::float8 latitude,ST_X(s.location)::float8 longitude from stores s join main_categories mc on mc.id=s.main_category_id and mc.city_id=s.city_id join media_assets logo on logo.id=s.logo_asset_id where s.id=$1 and s.city_id=$2 and ${PUBLIC_STORE_ELIGIBILITY_SQL}`,[storeId,cityId]) as PublicEligibleStore[];
  const store=rows[0];
  return store??null;
}
