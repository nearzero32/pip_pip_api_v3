import { SAMPLE } from "../samples";

const deviceCustomer = {
  device_id: "customer-device-001",
  device_name: "iPhone",
};
const deviceDriver = {
  device_id: "driver-device-001",
  device_name: "Samsung Galaxy",
};
const deviceDashboard = {
  device_id: "dashboard-browser-001",
  device_name: "Angular Dashboard",
};
const deviceMerchant = {
  device_id: "merchant-device-001",
  device_name: "Merchant Android",
};

export const authExamples = {
  dashboardLogin: {
    email: "superadmin@example.com",
    password: SAMPLE.password,
    ...deviceDashboard,
  },
  driverLogin: {
    phone: SAMPLE.phone,
    code: "123456",
    ...deviceDriver,
  },
  merchantLogin: {
    phone: SAMPLE.phone,
    password: SAMPLE.password,
    ...deviceMerchant,
  },
  customerOtpRequest: { phone: SAMPLE.phone },
  customerOtpVerify: {
    challenge_id: SAMPLE.challengeId,
    otp: "123456",
    ...deviceCustomer,
  },
  refresh: { refresh_token: SAMPLE.refreshToken },
  merchantPassword: {
    currentPassword: SAMPLE.password,
    newPassword: "StrongPassword456!",
  },
  createAdmin: {
    email: "city-admin@example.com",
    password: SAMPLE.password,
    cityId: SAMPLE.cityId,
    displayName: "Baghdad Admin",
  },
  patchAdmin: {
    displayName: "Baghdad Admin",
    cityId: SAMPLE.cityId,
    status: "ACTIVE",
  },
  createEmployee: {
    email: "ops@example.com",
    password: SAMPLE.password,
    role: "OPERATIONS",
    displayName: "Operations",
  },
  patchEmployee: { displayName: "Operations", status: "ACTIVE" },
  grantPermission: { permission: "orders.read" },
  createMerchant: {
    phone: SAMPLE.phone,
    password: SAMPLE.password,
    storeId: SAMPLE.storeId,
    displayName: "Store Merchant",
  },
  patchMerchant: { displayName: "Store Merchant", status: "ACTIVE" },
  merchantPasswordAdmin: { password: SAMPLE.password },
  assignMerchantStore: { storeId: SAMPLE.storeId },
};

export const sessionExamples = {
  dashboard: {
    access_token: SAMPLE.accessToken,
    access_token_expires_at: SAMPLE.instant,
    refresh_token: SAMPLE.refreshToken,
    session_id: SAMPLE.sessionId,
    application_type: "DASHBOARD" as const,
  },
  driver: {
    access_token: SAMPLE.accessToken,
    access_token_expires_at: SAMPLE.instant,
    refresh_token: SAMPLE.refreshToken,
    session_id: SAMPLE.sessionId,
    application_type: "DRIVER_APP" as const,
  },
  customer: {
    access_token: SAMPLE.accessToken,
    access_token_expires_at: SAMPLE.instant,
    refresh_token: SAMPLE.refreshToken,
    session_id: SAMPLE.sessionId,
    application_type: "CUSTOMER_APP" as const,
  },
  merchant: {
    access_token: SAMPLE.accessToken,
    access_token_expires_at: SAMPLE.instant,
    refresh_token: SAMPLE.refreshToken,
    session_id: SAMPLE.sessionId,
    application_type: "MERCHANT_APP" as const,
  },
};
