export type AuthApplication = "CUSTOMER_APP" | "DRIVER_APP" | "DASHBOARD";
export type AuthAudience = "customer-app" | "driver-app" | "dashboard";

export type AuthenticationContext =
  | { applicationType: "CUSTOMER_APP"; audience: "customer-app"; namespace: "customer" }
  | { applicationType: "DRIVER_APP"; audience: "driver-app"; namespace: "driver" }
  | { applicationType: "DASHBOARD"; audience: "dashboard"; namespace: "dashboard" };

export const customerContext = { applicationType: "CUSTOMER_APP", audience: "customer-app", namespace: "customer" } as const;
export const driverContext = { applicationType: "DRIVER_APP", audience: "driver-app", namespace: "driver" } as const;
export const dashboardContext = { applicationType: "DASHBOARD", audience: "dashboard", namespace: "dashboard" } as const;
