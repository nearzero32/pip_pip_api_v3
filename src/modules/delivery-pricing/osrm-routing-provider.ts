import type { Logger } from "../../observability/logger";
import { RoutingError, type Coordinates, type RouteResult, type RoutingClassification, type RoutingContext, type RoutingProvider } from "./routing-provider";

type FetchLike=(input:string,init?:RequestInit)=>Promise<Response>;
const temporaryStatuses=new Set([408,429,502,503,504]);
const validCoordinates=(p:Coordinates)=>Number.isFinite(p.latitude)&&p.latitude>=-90&&p.latitude<=90&&Number.isFinite(p.longitude)&&p.longitude>=-180&&p.longitude<=180;

export class OsrmRoutingProvider implements RoutingProvider {
  readonly name="OSRM";
  private readonly host:string;
  constructor(private readonly baseUrl:string,profile:"driving",private readonly timeoutMs:number,private readonly logger:Logger,private readonly fetcher:FetchLike=fetch,private readonly wait:(ms:number)=>Promise<void>=(ms)=>new Promise(resolve=>setTimeout(resolve,ms))) {
    if(profile!=="driving") throw new Error("OSRM profile must be driving");
    this.host=new URL(baseUrl).host;
  }
  async route(origin:Coordinates,destination:Coordinates,context:RoutingContext):Promise<RouteResult> {
    if(!validCoordinates(origin)||!validCoordinates(destination)) throw this.error("INVALID_COORDINATES",1,0,null,null,false,"InvalidCoordinates");
    const points=`${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const url=`${this.baseUrl}/route/v1/driving/${points}?overview=false&steps=false`;
    for(let attempt=1;attempt<=2;attempt++) {
      const started=performance.now(); const timeout=AbortSignal.timeout(this.timeoutMs); const signal=context.signal?AbortSignal.any([timeout,context.signal]):timeout;
      try {
        const response=await this.fetcher(url,{signal});
        if(!response.ok) {
          const retryable=temporaryStatuses.has(response.status);
          const classification:RoutingClassification=retryable?"TEMPORARY_HTTP_ERROR":"PERMANENT_HTTP_ERROR";
          const error=this.error(classification,attempt,performance.now()-started,response.status,null,retryable,"HttpError");
          this.log(context,error.details,"ERROR");
          if(retryable&&attempt===1){await this.wait(this.retryDelay(response.headers.get("retry-after")));continue;}
          throw error;
        }
        let body:unknown;
        try{body=await response.json();}catch{const error=this.error("INVALID_JSON",attempt,performance.now()-started,response.status,null,false,"SyntaxError");this.log(context,error.details,"ERROR");throw error;}
        const value=body as {code?:unknown;routes?:unknown};
        if(value.code==="NoRoute"){const error=this.error("NO_ROUTE",attempt,performance.now()-started,response.status,"NoRoute",false,"NoRoute");this.log(context,error.details,"NO_ROUTE");throw error;}
        const route=Array.isArray(value.routes)?value.routes[0] as {distance?:unknown;duration?:unknown}|undefined:undefined;
        if(value.code!=="Ok"||!route||typeof route.distance!=="number"||typeof route.duration!=="number"||!Number.isFinite(route.distance)||!Number.isFinite(route.duration)||route.distance<0||route.duration<0){const error=this.error("INVALID_PROVIDER_RESPONSE",attempt,performance.now()-started,response.status,typeof value.code==="string"?value.code:null,false,"ProviderSchemaError");this.log(context,error.details,"ERROR");throw error;}
        this.log(context,{provider:this.name,classification:"INTERNAL_ERROR",attemptNumber:attempt,providerHost:this.host,httpStatus:response.status,providerResponseCode:"Ok",latencyMs:performance.now()-started,timeout:false,retryable:false,causeName:"None"},"SUCCESS");
        return {distanceMeters:route.distance,durationSeconds:route.duration,provider:this.name,attempts:attempt};
      } catch(cause) {
        if(cause instanceof RoutingError) throw cause;
        const cancelled=Boolean(context.signal?.aborted); const timedOut=!cancelled&&timeout.aborted;
        const classification:RoutingClassification=cancelled?"REQUEST_CANCELLED":timedOut?"TIMEOUT":cause instanceof TypeError?"NETWORK_ERROR":"INTERNAL_ERROR";
        const retryable=classification==="TIMEOUT"||classification==="NETWORK_ERROR";
        const error=this.error(classification,attempt,performance.now()-started,null,null,retryable,cause instanceof Error?cause.name:"UnknownError");
        this.log(context,error.details,"ERROR");
        if(retryable&&attempt===1){await this.wait(50+Math.floor(Math.random()*51));continue;}
        throw error;
      }
    }
    throw this.error("INTERNAL_ERROR",2,0,null,null,false,"Unreachable");
  }
  private retryDelay(retryAfter:string|null){const seconds=retryAfter&&/^\d+$/.test(retryAfter)?Number(retryAfter):0;return seconds>0&&seconds<=1?seconds*1000:50+Math.floor(Math.random()*51);}
  private error(classification:RoutingClassification,attemptNumber:number,latencyMs:number,httpStatus:number|null,providerResponseCode:string|null,retryable:boolean,causeName:string){return new RoutingError({provider:this.name,classification,attemptNumber,providerHost:this.host,httpStatus,providerResponseCode,latencyMs:Math.round(latencyMs*100)/100,timeout:classification==="TIMEOUT",retryable,causeName});}
  private log(context:RoutingContext,details:RoutingError["details"],outcome:string){this.logger.info({event:"routing_attempt",request_id:context.requestId,city_id:context.cityId,store_id:context.storeId,pricing_version_id:context.pricingVersionId,provider:details.provider,provider_host:details.providerHost,attempt_number:details.attemptNumber,http_status:details.httpStatus,provider_response_code:details.providerResponseCode,latency_ms:details.latencyMs,timeout:details.timeout,retryable:details.retryable,error_classification:outcome==="SUCCESS"?null:details.classification,error_name:details.causeName,final_outcome:outcome});}
}
