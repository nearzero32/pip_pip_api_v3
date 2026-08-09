import type { SQL } from "bun";
import { AppError } from "../../errors/app-error";
import type { Logger } from "../../observability/logger";
import type { AuthIdentity } from "../auth/sessions/session-service";
import { requireCityAdmin, requireSuperAdmin } from "../auth/staff/authorization";
import { calculateDeliveryFee, fallbackPricingDistance, type PricingTerms } from "./pricing";
import { RouteNotFoundError, type Coordinates, type RoutingProvider } from "./routing-provider";

export type PricingInput = PricingTerms & {
  routingFallbackEnabled:boolean; fallbackOnNoRoute:boolean; fallbackOnProviderFailure:boolean; fallbackExtraDistanceMeters:number;
};
type PricingRow = PricingInput & { id:string; cityId:string; version:number; status:"DRAFT"|"ACTIVE"|"INACTIVE"; createdByAccountId:string; createdAt:string; activatedAt:string|null; deactivatedAt:string|null };
const iso=(value:Date|string|null)=>value==null?null:value instanceof Date?value.toISOString():new Date(value).toISOString();
const mapRow=(row:any):PricingRow=>({id:row.id,cityId:row.cityId,version:row.version,status:row.status,baseFee:row.baseFee,includedDistanceMeters:row.includedDistanceMeters,pricePerKm:row.pricePerKm,roundingStep:row.roundingStep,maximumDeliveryDistanceMeters:row.maximumDeliveryDistanceMeters,routingFallbackEnabled:row.routingFallbackEnabled,fallbackOnNoRoute:row.fallbackOnNoRoute,fallbackOnProviderFailure:row.fallbackOnProviderFailure,fallbackExtraDistanceMeters:row.fallbackExtraDistanceMeters,createdByAccountId:row.createdByAccountId,createdAt:iso(row.createdAt)!,activatedAt:iso(row.activatedAt),deactivatedAt:iso(row.deactivatedAt)});
const columns=`id, city_id as "cityId", version, status, base_fee as "baseFee", included_distance_meters as "includedDistanceMeters", price_per_km as "pricePerKm", rounding_step as "roundingStep", maximum_delivery_distance_meters as "maximumDeliveryDistanceMeters", routing_fallback_enabled as "routingFallbackEnabled", fallback_on_no_route as "fallbackOnNoRoute", fallback_on_provider_failure as "fallbackOnProviderFailure", fallback_extra_distance_meters as "fallbackExtraDistanceMeters", created_by_account_id as "createdByAccountId", created_at as "createdAt", activated_at as "activatedAt", deactivated_at as "deactivatedAt"`;

export class DeliveryPricingService {
  constructor(private readonly client:SQL, private readonly routing:RoutingProvider, private readonly logger:Logger) {}
  private validate(input:PricingInput) {
    for(const [key,value] of Object.entries(input)) if(typeof value==="number" && (!Number.isSafeInteger(value)||value<0)) throw new AppError(422,"VALIDATION_FAILED",`Invalid ${key}`);
    if(input.roundingStep<=0 || input.maximumDeliveryDistanceMeters===0) throw new AppError(422,"VALIDATION_FAILED","Invalid pricing configuration");
    if(!input.routingFallbackEnabled&&(input.fallbackOnNoRoute||input.fallbackOnProviderFailure)) throw new AppError(422,"VALIDATION_FAILED","Fallback policies require routingFallbackEnabled");
  }
  async create(identity:AuthIdentity,cityId:string,input:PricingInput) {
    requireSuperAdmin(identity); this.validate(input);
    return this.client.begin(async tx=>{
      await tx`select pg_advisory_xact_lock(hashtextextended(${`delivery-pricing:${cityId}`},0))`;
      const [city]=await tx<{status:string}[]>`select status from cities where id=${cityId} for update`;
      if(!city||city.status==="ARCHIVED") throw new AppError(404,"CITY_NOT_FOUND","City not found");
      const [seq]=await tx<{version:number}[]>`select coalesce(max(version),0)::int+1 as version from city_delivery_pricing_versions where city_id=${cityId}`;
      const rows=await tx.unsafe(`insert into city_delivery_pricing_versions(city_id,version,base_fee,included_distance_meters,price_per_km,rounding_step,maximum_delivery_distance_meters,routing_fallback_enabled,fallback_on_no_route,fallback_on_provider_failure,fallback_extra_distance_meters,created_by_account_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning ${columns}`,[cityId,seq!.version,input.baseFee,input.includedDistanceMeters,input.pricePerKm,input.roundingStep,input.maximumDeliveryDistanceMeters,input.routingFallbackEnabled,input.fallbackOnNoRoute,input.fallbackOnProviderFailure,input.fallbackExtraDistanceMeters,identity.accountId]) as PricingRow[];
      this.logger.info({event:"delivery_pricing_created",city_id:cityId,version:seq!.version,account_id:identity.accountId});
      return mapRow(rows[0]);
    });
  }
  async activate(identity:AuthIdentity,cityId:string,id:string) {
    requireSuperAdmin(identity);
    return this.client.begin(async tx=>{
      await tx`select pg_advisory_xact_lock(hashtextextended(${`delivery-pricing:${cityId}`},0))`;
      const [city]=await tx<{status:string}[]>`select status from cities where id=${cityId} for update`;
      if(!city||city.status!=="ACTIVE") throw new AppError(409,"CITY_NOT_ACTIVE","City must be ACTIVE");
      const [target]=await tx<{status:string}[]>`select status from city_delivery_pricing_versions where id=${id} and city_id=${cityId} for update`;
      if(!target) throw new AppError(404,"DELIVERY_PRICING_NOT_FOUND","Pricing version not found");
      if(target.status==="INACTIVE") throw new AppError(409,"DELIVERY_PRICING_REACTIVATION_FORBIDDEN","Inactive pricing versions cannot be reactivated");
      if(target.status==="ACTIVE") { const rows=await tx.unsafe(`select ${columns} from city_delivery_pricing_versions where id=$1 and city_id=$2`,[id,cityId]) as PricingRow[]; return mapRow(rows[0]); }
      await tx`update city_delivery_pricing_versions set status='INACTIVE',deactivated_at=now() where city_id=${cityId} and status='ACTIVE'`;
      const rows=await tx.unsafe(`update city_delivery_pricing_versions set status='ACTIVE',activated_at=now() where id=$1 and city_id=$2 returning ${columns}`,[id,cityId]) as PricingRow[];
      this.logger.info({event:"delivery_pricing_activated",city_id:cityId,pricing_version_id:id,account_id:identity.accountId});
      return mapRow(rows[0]);
    });
  }
  async list(identity:AuthIdentity,cityId:string){requireSuperAdmin(identity);return (await this.client.unsafe(`select ${columns} from city_delivery_pricing_versions where city_id=$1 order by version desc`,[cityId]) as PricingRow[]).map(mapRow);}
  async getSuper(identity:AuthIdentity,cityId:string,id:string){requireSuperAdmin(identity);const rows=await this.client.unsafe(`select ${columns} from city_delivery_pricing_versions where city_id=$1 and id=$2`,[cityId,id]) as PricingRow[];if(!rows[0])throw new AppError(404,"DELIVERY_PRICING_NOT_FOUND","Pricing version not found");return mapRow(rows[0]);}
  async activeForSuper(identity:AuthIdentity,cityId:string){requireSuperAdmin(identity);return this.active(cityId);}
  async activeForAdmin(identity:AuthIdentity){return this.active(requireCityAdmin(identity));}
  private async active(cityId:string, tx:SQL=this.client){const rows=await tx.unsafe(`select ${columns} from city_delivery_pricing_versions where city_id=$1 and status='ACTIVE'`,[cityId]) as PricingRow[];if(!rows[0])throw new AppError(404,"ACTIVE_DELIVERY_PRICING_NOT_FOUND","Active delivery pricing not found");return mapRow(rows[0]);}

  async estimate(customerAccountId:string,cityId:string,input:{storeId:string;addressId?:string;destination?:Coordinates}) {
    if((!!input.addressId)===(!!input.destination)) throw new AppError(422,"VALIDATION_FAILED","Provide exactly one of addressId or destination");
    let destination=input.destination;
    if(destination && (!Number.isFinite(destination.latitude)||destination.latitude < -90||destination.latitude>90||!Number.isFinite(destination.longitude)||destination.longitude < -180||destination.longitude>180)) throw new AppError(422,"VALIDATION_FAILED","Invalid destination coordinates");
    if(input.addressId){const [address]=await this.client<{latitude:number;longitude:number}[]>`select ST_Y(location)::float8 as latitude,ST_X(location)::float8 as longitude from customer_addresses where id=${input.addressId} and customer_account_id=${customerAccountId} and city_id=${cityId}`;if(!address)throw new AppError(404,"ADDRESS_NOT_FOUND","Address not found");destination=address;}
    const [store]=await this.client<{id:string;name:string;orderAcceptanceStatus:"ACCEPTING"|"PAUSED";latitude:number;longitude:number}[]>`select s.id,s.name,s.order_acceptance_status as "orderAcceptanceStatus",ST_Y(s.location)::float8 latitude,ST_X(s.location)::float8 longitude from stores s join main_categories mc on mc.id=s.main_category_id and mc.city_id=s.city_id where s.id=${input.storeId} and s.city_id=${cityId} and s.status='ACTIVE' and s.archived_at is null and mc.status='ACTIVE' and mc.archived_at is null`;
    if(!store)throw new AppError(404,"STORE_NOT_FOUND","Store not found");
    const pricing=await this.active(cityId);
    const [geo]=await this.client<{inside:boolean;straight:number}[]>`select exists(select 1 from zones z join store_zones sz on sz.zone_id=z.id and sz.city_id=z.city_id where z.city_id=${cityId} and z.status='ACTIVE' and z.archived_at is null and sz.store_id=${store.id} and ST_Covers(z.boundary,ST_SetSRID(ST_MakePoint(${destination!.longitude},${destination!.latitude}),4326))) as inside,ST_DistanceSphere(ST_SetSRID(ST_MakePoint(${store.longitude},${store.latitude}),4326),ST_SetSRID(ST_MakePoint(${destination!.longitude},${destination!.latitude}),4326))::float8 as straight`;
    const base={cityId,store:{id:store.id,name:store.name,orderAcceptanceStatus:store.orderAcceptanceStatus},pricingVersion:{id:pricing.id,version:pricing.version},currency:"IQD" as const,straightLineDistanceMeters:Math.ceil(geo!.straight)};
    if(!geo!.inside)return {...base,deliveryAvailable:false,reason:"ADDRESS_OUTSIDE_DELIVERY_ZONE" as const,deliveryFee:null,distanceSource:null,pricingDistanceMeters:null,routeDistanceMeters:null,routeDurationSeconds:null,fallbackReason:null,billableDistanceMeters:null};
    let distance:number,source:"ROUTE"|"STRAIGHT_LINE_FALLBACK",duration:number|null=null,routeDistance:number|null=null,fallbackReason:"NO_ROUTE"|"PROVIDER_FAILURE"|null=null;
    try{const route=await this.routing.route({latitude:store.latitude,longitude:store.longitude},destination!);distance=route.distanceMeters;duration=route.durationSeconds;routeDistance=route.distanceMeters;source="ROUTE";}
    catch(error){const noRoute=error instanceof RouteNotFoundError;const allowed=pricing.routingFallbackEnabled&&(noRoute?pricing.fallbackOnNoRoute:pricing.fallbackOnProviderFailure);if(!allowed)throw new AppError(503,noRoute?"ROUTE_NOT_FOUND":"ROUTING_UNAVAILABLE",noRoute?"Route not found":"Routing unavailable");distance=fallbackPricingDistance(geo!.straight,pricing.fallbackExtraDistanceMeters);source="STRAIGHT_LINE_FALLBACK";fallbackReason=noRoute?"NO_ROUTE":"PROVIDER_FAILURE";this.logger.warn({event:"routing_fallback_used",city_id:cityId,store_id:store.id,reason:fallbackReason,provider:this.routing.name});}
    const calculated=calculateDeliveryFee(distance,pricing);
    return {...base,deliveryAvailable:true,reason:null,deliveryFee:calculated.deliveryFee,distanceSource:source,pricingDistanceMeters:distance,routeDistanceMeters:routeDistance,routeDurationSeconds:duration,fallbackReason,billableDistanceMeters:calculated.billableDistanceMeters};
  }
}
