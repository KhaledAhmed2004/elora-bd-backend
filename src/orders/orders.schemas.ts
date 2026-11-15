import { z } from 'zod';

import {
  CALL_RESULTS,
  ORDER_SOURCES,
  ORDER_STATUSES,
  PAYMENT_METHODS,
} from '../common/enums.js';
import { adminBdPhone, bdPhone } from '../common/phone.js';

const id = z.string().min(1).max(60);

/** Cart line from the browser: ids and quantity only — prices come from the database */
export const cartLineSchema = z.object({
  productId: id,
  variantId: id.nullish(),
  quantity: z.number().int().min(1).max(20),
});
export type CartLine = z.infer<typeof cartLineSchema>;

const cart = z
  .array(cartLineSchema)
  .min(1, 'Your cart is empty')
  .max(30)
  .refine(
    (lines) =>
      new Set(lines.map((l) => `${l.productId}|${l.variantId ?? ''}`)).size ===
      lines.length,
    'The same item is listed twice',
  );

const couponCode = z.string().trim().max(30).nullish();

export const quoteSchema = z.object({
  items: cart,
  couponCode,
  district: z.string().trim().max(40).nullish(),
});
export type QuoteInput = z.infer<typeof quoteSchema>;

const address = (phone: typeof bdPhone) =>
  z.object({
    fullName: z.string().trim().min(2, 'Please enter your name').max(80),
    phone,
    division: z.string().trim().min(1).max(40),
    district: z.string().trim().min(1).max(40),
    upazila: z.string().trim().min(1).max(60),
    address: z.string().trim().min(5, 'Please enter your full address').max(300),
  });

const advance = z.object({
  method: z.enum(['bkash', 'nagad']),
  trxId: z
    .string()
    .trim()
    .min(6, 'Please enter the transaction ID')
    .max(40)
    .transform((s) => s.toUpperCase()),
  senderNumber: z.string().trim().max(20).nullish(),
});

export const placeOrderSchema = z.object({
  items: cart,
  couponCode,
  shippingAddress: address(bdPhone),
  email: z.email().max(120).optional().or(z.literal('')),
  paymentMethod: z.enum(PAYMENT_METHODS),
  note: z.string().trim().max(300).nullish(),
  advance: advance.nullish(),
});
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>;

export const trackSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .min(3)
    .max(20)
    .transform((s) => s.toUpperCase()),
  phone: bdPhone,
});
export type TrackInput = z.infer<typeof trackSchema>;

/** Incomplete-checkout capture (debounced from the checkout form) */
export const leadSchema = z.object({
  phone: bdPhone,
  fullName: z.string().trim().max(80).nullish(),
  division: z.string().trim().max(40).nullish(),
  district: z.string().trim().max(40).nullish(),
  upazila: z.string().trim().max(60).nullish(),
  address: z.string().trim().max(300).nullish(),
  items: cart,
});
export type LeadInput = z.infer<typeof leadSchema>;

// ───────── Admin ─────────

export const adminOrderQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  source: z.enum(ORDER_SOURCES).optional(),
  /** Order number, name or phone */
  q: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(20).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  courierSettled: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  /** Up to 500 for CSV export / bulk printing */
  limit: z.coerce.number().int().min(1).max(500).default(20),
});
export type AdminOrderQuery = z.infer<typeof adminOrderQuerySchema>;

/** Manual order (Facebook / WhatsApp / phone) and order edits */
export const adminOrderSchema = z.object({
  source: z.enum(ORDER_SOURCES).default('facebook'),
  items: z
    .array(
      cartLineSchema.extend({
        /** Admin may sell at a different price (bargain); defaults to the current price */
        price: z.number().int().min(0).max(10_000_000).nullish(),
      }),
    )
    .min(1)
    .max(30),
  shippingAddress: address(adminBdPhone),
  paymentMethod: z.enum(PAYMENT_METHODS).default('cod'),
  /** null = calculate from settings */
  deliveryCharge: z.number().int().min(0).max(100_000).nullish(),
  discount: z.number().int().min(0).max(10_000_000).default(0),
  note: z.string().trim().max(300).nullish(),
  adminNote: z.string().trim().max(1000).nullish(),
  advance: z
    .object({
      amount: z.number().int().min(1).max(10_000_000),
      method: z.enum(['bkash', 'nagad']),
      trxId: z.string().trim().max(40).default(''),
    })
    .nullish(),
  /** Status right after creating (manual orders are usually already confirmed on the phone) */
  status: z.enum(['pending', 'confirmed']).default('confirmed'),
  /** Incomplete checkout this order recovers (marked converted) */
  leadId: z.string().max(60).nullish(),
});
export type AdminOrderInput = z.infer<typeof adminOrderSchema>;

export const statusChangeSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().trim().max(300).nullish(),
  /** For cancel/return: put items back in stock (false = damaged) */
  restock: z.boolean().default(true),
});
export type StatusChangeInput = z.infer<typeof statusChangeSchema>;

export const bulkStatusSchema = z.object({
  ids: z.array(id).min(1).max(200),
  status: z.enum(ORDER_STATUSES),
});

export const callSchema = z.object({
  result: z.enum(CALL_RESULTS),
  note: z.string().trim().max(300).nullish(),
});
export type CallInput = z.infer<typeof callSchema>;

export const adminNoteSchema = z.object({
  adminNote: z.string().trim().max(1000),
});

export const verifyAdvanceSchema = z.object({ verified: z.boolean() });

export const returnSchema = z.object({
  reason: z.string().trim().min(2).max(300),
  restock: z.boolean().default(true),
  refundAmount: z.number().int().min(0).max(10_000_000).default(0),
  refundMethod: z.string().trim().max(40).default('bkash'),
});
export type ReturnInput = z.infer<typeof returnSchema>;

export const courierBookSchema = z.object({
  ids: z.array(id).min(1).max(200),
  courier: z.enum(['Steadfast', 'Pathao', 'RedX']),
});

export const settleSchema = z.object({
  ids: z.array(id).min(1).max(500),
  settled: z.boolean().default(true),
});

export const blacklistSchema = z.object({
  phone: adminBdPhone,
  reason: z.string().trim().min(2).max(200),
});

export const idParam = id;
export const phoneParam = adminBdPhone;
