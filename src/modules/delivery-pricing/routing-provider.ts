export type Coordinates = { latitude: number; longitude: number };
export type RouteResult = { distanceMeters: number; durationSeconds: number };

export class RouteNotFoundError extends Error {}
export class RoutingProviderError extends Error {}

export interface RoutingProvider {
  readonly name: string;
  route(origin: Coordinates, destination: Coordinates): Promise<RouteResult>;
}

export class FakeRoutingProvider implements RoutingProvider {
  readonly name = "FAKE";
  calls = 0;
  constructor(private result: RouteResult | Error) {}
  setResult(result: RouteResult | Error) { this.result = result; }
  async route(): Promise<RouteResult> {
    this.calls++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
