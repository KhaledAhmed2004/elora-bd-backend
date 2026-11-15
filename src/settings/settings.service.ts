import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { adminBdPhone } from '../common/phone.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DEFAULT_STORE_SETTINGS,
  type StoreSettings,
} from './settings.defaults.js';

const taka = z.number().int().min(0).max(100_000);

export const storeSettingsSchema = z.object({
  storeName: z.string().trim().min(2).max(60),
  phone: z.string().trim().min(6).max(30),
  email: z.email().max(120),
  whatsapp: z
    .string()
    .trim()
    .regex(/^8801[3-9]\d{8}$/, 'Must start with 880, e.g. 8801712345678'),
  address: z.string().trim().min(3).max(200),
  announcement: z.string().trim().max(120),
  delivery: z.object({
    insideDhaka: taka,
    outsideDhaka: taka,
    freeDeliveryMinimum: z.number().int().min(0).max(10_000_000),
  }),
  courierCharge: z.object({ insideDhaka: taka, outsideDhaka: taka }),
  payments: z
    .object({
      cod: z.boolean(),
      bkash: z.boolean(),
      nagad: z.boolean(),
      sslcommerz: z.boolean(),
    })
    .refine(
      (p) => Object.values(p).some(Boolean),
      'Keep at least one payment method',
    ),
  advance: z.object({
    mode: z.enum(['none', 'delivery-charge', 'outside-dhaka']),
    bkashNumber: adminBdPhone,
    nagadNumber: adminBdPhone,
  }),
  invoiceLang: z.enum(['en', 'bn']),
  newOrderSound: z.boolean(),
  tracking: z.object({
    fbPixelId: z
      .string()
      .trim()
      .regex(/^(\d{10,20})?$/, 'Pixel ID is a number'),
    gtmId: z
      .string()
      .trim()
      .regex(/^(GTM-[A-Z0-9]{4,12})?$/i, 'Looks like GTM-XXXXXXX'),
    ga4Id: z
      .string()
      .trim()
      .regex(/^(G-[A-Z0-9]{4,15})?$/i, 'Looks like G-XXXXXXXXXX'),
    capiTestCode: z.string().trim().max(40),
  }),
});

const CACHE_MS = 30_000;

/** Shop settings, stored as JSON (settings.key = "store"), cached for 30 s */
@Injectable()
export class SettingsService {
  private cache?: { value: StoreSettings; at: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async get(): Promise<StoreSettings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS)
      return this.cache.value;
    const row = await this.prisma.setting.findUnique({
      where: { key: 'store' },
    });
    const stored = (row?.value ?? {}) as Partial<StoreSettings>;
    // Fill fields added after the row was saved
    const value: StoreSettings = {
      ...DEFAULT_STORE_SETTINGS,
      ...stored,
      delivery: { ...DEFAULT_STORE_SETTINGS.delivery, ...stored.delivery },
      courierCharge: {
        ...DEFAULT_STORE_SETTINGS.courierCharge,
        ...stored.courierCharge,
      },
      payments: { ...DEFAULT_STORE_SETTINGS.payments, ...stored.payments },
      advance: { ...DEFAULT_STORE_SETTINGS.advance, ...stored.advance },
      tracking: { ...DEFAULT_STORE_SETTINGS.tracking, ...stored.tracking },
    };
    this.cache = { value, at: Date.now() };
    return value;
  }

  /** What the shop pages need (no internal courier costs) */
  async getPublic() {
    const {
      courierCharge: _internal,
      newOrderSound: _admin,
      ...rest
    } = await this.get();
    return rest;
  }

  async update(me: AdminPrincipal, value: StoreSettings) {
    await this.prisma.setting.upsert({
      where: { key: 'store' },
      create: { key: 'store', value },
      update: { value },
    });
    this.cache = undefined;
    await this.activity.log(me, 'settings.update', 'Shop settings updated');
    return this.get();
  }
}
