/**
 * Shop settings (same shape as the frontend's StoreSettings).
 * Stored as JSON in settings.key = "store".
 * Placeholder contact details MUST be replaced from the admin before launch.
 */
export type StoreSettings = {
  storeName: string;
  phone: string;
  email: string;
  whatsapp: string;
  address: string;
  announcement: string;
  delivery: {
    insideDhaka: number;
    outsideDhaka: number;
    freeDeliveryMinimum: number;
  };
  courierCharge: { insideDhaka: number; outsideDhaka: number };
  payments: {
    cod: boolean;
    bkash: boolean;
    nagad: boolean;
    sslcommerz: boolean;
  };
  advance: {
    mode: 'none' | 'delivery-charge' | 'outside-dhaka';
    bkashNumber: string;
    nagadNumber: string;
  };
  invoiceLang: 'en' | 'bn';
  newOrderSound: boolean;
  tracking: {
    fbPixelId: string;
    gtmId: string;
    ga4Id: string;
    capiTestCode: string;
  };
};

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  storeName: 'BD Shop',
  phone: '+8801XXXXXXXXX',
  email: 'support@example.com',
  whatsapp: '8801XXXXXXXXX',
  address: 'Dhaka, Bangladesh',
  announcement: '',
  delivery: { insideDhaka: 60, outsideDhaka: 120, freeDeliveryMinimum: 2000 },
  courierCharge: { insideDhaka: 60, outsideDhaka: 110 },
  payments: { cod: true, bkash: true, nagad: true, sslcommerz: true },
  advance: {
    mode: 'none',
    bkashNumber: '01XXXXXXXXX',
    nagadNumber: '01XXXXXXXXX',
  },
  invoiceLang: 'en',
  newOrderSound: true,
  // The Conversions API token is a secret → it lives in .env, never in this JSON
  tracking: { fbPixelId: '', gtmId: '', ga4Id: '', capiTestCode: '' },
};
