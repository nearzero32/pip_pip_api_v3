export type Coordinates = { latitude: number; longitude: number };
export type RoutingClassification = "NO_ROUTE"|"TIMEOUT"|"NETWORK_ERROR"|"TEMPORARY_HTTP_ERROR"|"PERMANENT_HTTP_ERROR"|"INVALID_JSON"|"INVALID_PROVIDER_RESPONSE"|"INVALID_COORDINATES"|"REQUEST_CANCELLED"|"INTERNAL_ERROR";
export type RoutingContext = { requestId:string; cityId:string; storeId:string; pricingVersionId:string; signal?:AbortSignal };
export type RouteResult = { distanceMeters:number; durationSeconds:number; provider:string; attempts:number };
export type RoutingErrorDetails = { provider:string; classification:RoutingClassification; attemptNumber:number; providerHost:string; httpStatus:number|null; providerResponseCode:string|null; latencyMs:number; timeout:boolean; retryable:boolean; causeName:string };

export class RoutingError extends Error {
  constructor(readonly details:RoutingErrorDetails, message="Routing failed") { super(message); this.name="RoutingError"; }
}

export interface RoutingProvider {
  readonly name:string;
  route(origin:Coordinates,destination:Coordinates,context:RoutingContext):Promise<RouteResult>;
}

export class FakeRoutingProvider implements RoutingProvider {
  readonly name="FAKE";
  calls=0;
  private queue:(Omit<RouteResult,"provider"|"attempts">|RoutingError)[];
  constructor(result:Omit<RouteResult,"provider"|"attempts">|RoutingError){this.queue=[result];}
  setResult(result:Omit<RouteResult,"provider"|"attempts">|RoutingError){this.queue=[result];}
  setResults(results:(Omit<RouteResult,"provider"|"attempts">|RoutingError)[]){this.queue=[...results];}
  async route(_origin:Coordinates,_destination:Coordinates,_context:RoutingContext){this.calls++;const result=this.queue.length>1?this.queue.shift()!:this.queue[0]!;if(result instanceof RoutingError)throw result;return {...result,provider:this.name,attempts:1};}
}

export const fakeRoutingError=(classification:RoutingClassification,retryable=false)=>new RoutingError({provider:"FAKE",classification,attemptNumber:retryable?2:1,providerHost:"fake",httpStatus:null,providerResponseCode:null,latencyMs:1,timeout:classification==="TIMEOUT",retryable,causeName:"FakeRoutingError"});
