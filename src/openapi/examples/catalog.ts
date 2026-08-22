import { SAMPLE } from "../samples";

export const geographyExamples = {
  cityCreate: {
    governorateId: SAMPLE.governorateId,
    translations: [{ locale: "ar", name: "بغداد" }, { locale: "en", name: "Baghdad" }],
    latitude: SAMPLE.baghdadLat,
    longitude: SAMPLE.baghdadLng,
    displayOrder: 1,
    boundary: { type: "Polygon", coordinates: [[[44.3,33.2],[44.5,33.2],[44.5,33.4],[44.3,33.4],[44.3,33.2]]] },
  },
  cityPatch: {
    translations: [{ locale: "ar", name: "بغداد" }, { locale: "en", name: "Baghdad" }],
    latitude: SAMPLE.baghdadLat,
    longitude: SAMPLE.baghdadLng,
    displayOrder: 1,
    boundary: { type: "Polygon", coordinates: [[[44.3,33.2],[44.5,33.2],[44.5,33.4],[44.3,33.4],[44.3,33.2]]] },
  },
  governoratePatch: { status: "ACTIVE" },
  zoneCreate: {
    cityId: "11111111-1111-4111-8111-000000000001",
    translations: [{ locale: "ar", name: "كرادة" }, { locale: "en", name: "Karrada" }],
    boundary: {
      type: "Polygon",
      coordinates: [
        [
          [44.36, 33.3],
          [44.4, 33.3],
          [44.4, 33.33],
          [44.36, 33.33],
          [44.36, 33.3],
        ],
      ],
    },
  },
  zonePatch: {
    translations: [{ locale: "ar", name: "كرادة" }, { locale: "en", name: "Karrada" }],
    status: "ACTIVE",
  },
};

export const mediaExamples = {
  uploadIntent: {
    purpose: "PRODUCT_IMAGE",
    fileName: "product.jpg",
    contentType: "image/jpeg",
    sizeBytes: 245_760,
  },
};

export const catalogExamples = {
  mainCategoryCreate: {
    name: "Restaurants",
    displayOrder: 1,
    imageAssetId: SAMPLE.mediaAssetId,
  },
  mainCategoryPatch: { name: "Restaurants", displayOrder: 1, status: "ACTIVE" },
  subcategoryCreate: {
    name: "Fast food",
    displayOrder: 1,
    imageAssetId: SAMPLE.mediaAssetId,
  },
  storeCategoryCreate: { name: "Burgers", parentId: null, displayOrder: 1 },
  storeCreate: {
    mainCategoryId: SAMPLE.mainCategoryId,
    translations: [
      { locale: "ar", name: "مطعم تجريبي", address: "الكرادة، بغداد" },
      { locale: "en", name: "Demo Grill", address: "Karrada, Baghdad" },
    ],
    phone: SAMPLE.phone,
    latitude: SAMPLE.baghdadLat,
    longitude: SAMPLE.baghdadLng,
    logoAssetId: SAMPLE.logoAssetId,
    coverAssetId: SAMPLE.coverAssetId,
    status: "ACTIVE",
    orderAcceptanceStatus: "ACCEPTING",
    displayOrder: 1,
    zoneIds: [SAMPLE.zoneId],
    subcategoryIds: [SAMPLE.subcategoryId],
    workingHours: [
      {
        dayOfWeek: "SUNDAY",
        opensAt: "10:00",
        closesAt: "23:00",
      },
    ],
  },
  productBasePrice: {
    translations: [
      { locale: "ar", name: "برغر", description: "برغر لحم" },
      { locale: "en", name: "Burger", description: "Beef burger" },
    ],
    categoryId: SAMPLE.storeCategoryId,
    modifierGroupId: SAMPLE.modifierGroupId,
    basePrice: 5000,
    status: "ACTIVE",
    isAvailable: true,
    displayOrder: 1,
    images: [
      { assetId: SAMPLE.mediaAssetId, isPrimary: true, displayOrder: 0 },
    ],
  },
  productSized: {
    translations: [
      { locale: "ar", name: "بيتزا", description: "بيتزا بأحجام متعددة" },
      { locale: "en", name: "Pizza", description: "Sized pizza" },
    ],
    categoryId: SAMPLE.storeCategoryId,
    basePrice: null,
    status: "ACTIVE",
    isAvailable: true,
    displayOrder: 1,
    images: [
      { assetId: SAMPLE.mediaAssetId, isPrimary: true, displayOrder: 0 },
    ],
    sizes: [
      {
        name: "Medium",
        price: 8000,
        isDefault: true,
        status: "ACTIVE",
        displayOrder: 0,
      },
    ],
  },
  modifierGroupCreate: { name: "Extras", displayOrder: 1 },
  modifierOptionCreate: { name: "Cheese", displayOrder: 1 },
};

export const cartExamples = {
  addBase: {
    storeId: SAMPLE.storeId,
    productId: SAMPLE.productId,
    quantity: 1,
    modifierSelections: [
      { modifierOptionId: SAMPLE.modifierOptionId, quantity: 1 },
    ],
  },
  addSized: {
    storeId: SAMPLE.storeId,
    productId: SAMPLE.productId,
    sizeId: SAMPLE.sizeId,
    quantity: 1,
    modifierSelections: [
      { modifierOptionId: SAMPLE.modifierOptionId, quantity: 1 },
    ],
  },
  updateItem: {
    quantity: 2,
    sizeId: SAMPLE.sizeId,
    modifierSelections: [
      { modifierOptionId: SAMPLE.modifierOptionId, quantity: 1 },
    ],
  },
};

export const addressExamples = {
  create: {
    label: "Home",
    location: { latitude: SAMPLE.baghdadLat, longitude: SAMPLE.baghdadLng },
    addressDetails: "Street 12, building 4",
    landmark: "Near the park",
    recipientName: "Ahmed",
    recipientPhone: SAMPLE.phone,
    isDefault: true,
  },
};
