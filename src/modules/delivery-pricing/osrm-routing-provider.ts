import type { Coordinates, RouteResult, RoutingProvider } from "./routing-provider";
import { RouteNotFoundError, RoutingProviderError } from "./routing-provider";

export class OsrmRoutingProvider implements RoutingProvider {
  readonly name = "OSRM";
  constructor(private readonly baseUrl: string, private readonly profile = "driving", private readonly timeoutMs = 3000) {}
  async route(origin: Coordinates, destination: Coordinates): Promise<RouteResult> {
    const points = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    const url = `${this.baseUrl}/route/v1/${encodeURIComponent(this.profile)}/${points}?overview=false&steps=false`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new RoutingProviderError("Routing provider returned an error");
      const body = await response.json() as { code?: string; routes?: { distance?: number; duration?: number }[] };
      if (body.code === "NoRoute") throw new RouteNotFoundError("No route found");
      const route = body.routes?.[0];
      if (body.code !== "Ok" || !route || !Number.isFinite(route.distance) || !Number.isFinite(route.duration) || route.distance! < 0 || route.duration! < 0) {
        throw new RoutingProviderError("Invalid routing provider response");
      }
      return { distanceMeters: route.distance!, durationSeconds: route.duration! };
    } catch (error) {
      if (error instanceof RouteNotFoundError || error instanceof RoutingProviderError) throw error;
      throw new RoutingProviderError("Routing provider unavailable");
    }
  }
}
