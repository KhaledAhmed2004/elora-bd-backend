import { z } from 'zod';

/** "+880 1712-345678" / "8801712345678" → "01712345678" */
export const normalizeBdPhone = (v: string) =>
  v.replace(/[\s-]/g, '').replace(/^\+?880/, '0');

const make = (message: string) =>
  z
    .string()
    .trim()
    .max(20)
    .transform(normalizeBdPhone)
    .pipe(z.string().regex(/^01[3-9]\d{8}$/, message));

/** Customer-facing (the shop's Banglish copy) */
export const bdPhone = make('Please enter a valid mobile number (e.g. 01712345678)');
/** Admin panel */
export const adminBdPhone = make(
  'Enter a valid mobile number (e.g. 01712345678)',
);
