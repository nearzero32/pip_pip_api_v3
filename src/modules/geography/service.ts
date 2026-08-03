import type { SQL } from "bun";
import type { SessionService } from "../auth/sessions/session-service";
import { CityService } from "./city/city.service";
import { GovernorateService } from "./governorate/governorate.service";
import { ZoneService } from "./zone/zone.service";

export {
  CITY_GOVERNORATE_FK_CONSTRAINT,
  isCityGovernorateForeignKeyViolation,
} from "./city/city.service";

/** Facade that owns Governorate, City, and Zone services for app wiring. */
export class GeographyService {
  readonly governorates: GovernorateService;
  readonly cities: CityService;
  readonly zones: ZoneService;

  constructor(client: SQL, sessions: SessionService) {
    this.governorates = new GovernorateService(client, sessions);
    this.cities = new CityService(client, sessions);
    this.zones = new ZoneService(client);
  }
}
