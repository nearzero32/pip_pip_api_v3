import { SAMPLE } from "../samples";

export const orderExamples = {
  create: {
    storeId: SAMPLE.storeId,
    addressId: SAMPLE.addressId,
    paymentMethod: "CASH",
    items: [
      {
        productId: SAMPLE.productId,
        sizeId: SAMPLE.sizeId,
        quantity: 1,
        modifierSelections: [
          { modifierOptionId: SAMPLE.modifierOptionId, quantity: 1 },
        ],
      },
    ],
    idempotencyKey: SAMPLE.idempotencyKey,
  },
  cancel: { reason: "Customer requested cancellation" },
  replaceItem: {
    productId: SAMPLE.productId,
    sizeId: SAMPLE.sizeId,
    quantity: 1,
    modifierSelections: [
      { modifierOptionId: SAMPLE.modifierOptionId, quantity: 1 },
    ],
    reason: "Item unavailable",
    customerAgreedByPhone: true,
  },
  quantity: { quantity: 2, reason: "Customer agreed quantity change" },
  addItem: {
    productId: SAMPLE.productId,
    sizeId: SAMPLE.sizeId,
    quantity: 1,
    reason: "Customer added an item by phone",
  },
  estimateSavedAddress: { storeId: SAMPLE.storeId, addressId: SAMPLE.addressId },
  estimateDirect: {
    storeId: SAMPLE.storeId,
    destination: {
      latitude: SAMPLE.baghdadLat,
      longitude: SAMPLE.baghdadLng,
    },
  },
  deliveryPricingCreate: {
    baseFee: 2000,
    includedDistanceMeters: 1000,
    pricePerKm: 500,
    roundingStep: 250,
    maximumDeliveryDistanceMeters: 15000,
    routingFallbackEnabled: true,
    fallbackOnNoRoute: true,
    fallbackOnProviderFailure: true,
    fallbackExtraDistanceMeters: 100,
  },
  driverPricing: {
    pricingBase: 2000,
    roundingUnit: 250,
    pricingStages: [{ afterSeconds: 60, increasePercentage: 10 }],
  },
  offerStop: { reason: "No available drivers" },
  assignDriver: { driverId: SAMPLE.driverId },
  proofUploadIntent: {
    assignmentId: SAMPLE.assignmentId,
    purpose: "PICKUP_PROOF",
    contentType: "image/jpeg",
    fileName: "pickup.jpg",
    sizeBytes: 180_000,
  },
  driverDelivery: {
    proofFileId: SAMPLE.mediaAssetId,
    collectedAmount: 12500,
    note: "Collected in cash",
  },
  dashboardDelivery: {
    collectedAmount: 12500,
    reason: "Dashboard completed collection",
    note: "Customer paid cash",
    actedOnBehalfOf: "DRIVER",
  },
  empty: {},
  arrival: { note: "Arrived at store" },
  override: { reason: "Dashboard override" },
  pickup: { proofFileId: SAMPLE.mediaAssetId, note: "Picked up" },
  handoff: { reason: "Handoff to another driver" },
  commission: {
    platformCommissionRate: 15,
    reason: "Seasonal adjustment",
    note: "Reviewed with finance",
  },
};
