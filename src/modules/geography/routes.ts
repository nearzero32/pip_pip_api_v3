import { Elysia } from "elysia";
import type { AuthModule } from "../auth/auth-module";
import { cityRoutes } from "./city/city.routes";
import { governorateRoutes } from "./governorate/governorate.routes";
import type { GeographyService } from "./service";
import { zoneRoutes } from "./zone/zone.routes";

export const geographyRoutes = (auth: AuthModule, service: GeographyService) =>
  new Elysia({ name: "geography-routes" })
    .use(governorateRoutes(auth, service.governorates))
    .use(cityRoutes(auth, service.cities))
    .use(zoneRoutes(auth, service.zones));
