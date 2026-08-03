import { Elysia } from "elysia";
import type { AuthModule } from "./auth-module";
import { dashboardAuthRoutes } from "./dashboard/dashboard-auth.routes";
import { customerAuthRoutes } from "./mobile/customer/customer-auth.routes";
import { driverAuthRoutes } from "./mobile/driver/driver-auth.routes";
export const authRoutes=(auth:AuthModule)=>new Elysia({name:"application-auth-routes"}).use(customerAuthRoutes(auth)).use(driverAuthRoutes(auth)).use(dashboardAuthRoutes(auth));
