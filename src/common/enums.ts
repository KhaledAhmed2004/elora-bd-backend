/**
 * The API speaks the frontend's lower-case values ("pending", "no-answer");
 * the database uses Prisma enums ("PENDING", "NO_ANSWER").
 */
export const toDbEnum = <T extends string>(v: string) =>
  v.toUpperCase().replace(/-/g, '_') as T;

export const fromDbEnum = <T extends string>(v: string) =>
  v.toLowerCase().replace(/_/g, '-') as T;

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;
export type ApiOrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_METHODS = ['cod', 'bkash', 'nagad', 'sslcommerz'] as const;
export type ApiPaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ORDER_SOURCES = [
  'website',
  'facebook',
  'whatsapp',
  'phone',
  'instagram',
] as const;

export const CALL_RESULTS = [
  'confirmed',
  'no-answer',
  'busy',
  'callback',
  'cancelled',
] as const;
