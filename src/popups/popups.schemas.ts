import { z } from 'zod';

const text = (max: number) => z.string().trim().max(max);
/** Empty string → null so a cleared form field wipes the value */
const optionalText = (max: number) =>
  text(max)
    .nullish()
    .transform((v) => (v ? v : null));

const optionalUrl = z
  .union([z.url().max(2000), z.literal('')])
  .nullish()
  .transform((v) => v || null);

/** Internal path ("/category/saree") or full URL */
const optionalHref = z
  .union([
    text(500).regex(
      /^(\/|https?:\/\/)/,
      'Use a path like /products or a full URL',
    ),
    z.literal(''),
  ])
  .nullish()
  .transform((v) => v || null);

export const popupInputSchema = z
  .object({
    /** Internal name, admins only */
    name: text(80).min(2),
    badge: optionalText(40),
    title: text(120).min(2),
    subtitle: optionalText(300),
    image: optionalUrl,
    cta: optionalText(30),
    href: optionalHref,
    couponCode: optionalText(30).transform((v) => v?.toUpperCase() ?? null),
    layout: z.enum(['IMAGE', 'SPLIT', 'TEXT']).default('SPLIT'),
    trigger: z
      .enum(['ON_LOAD', 'DELAY', 'SCROLL', 'EXIT_INTENT'])
      .default('DELAY'),
    delaySeconds: z.number().int().min(0).max(300).default(5),
    scrollPercent: z.number().int().min(5).max(95).default(40),
    frequency: z.enum(['ONCE', 'DAILY', 'SESSION', 'ALWAYS']).default('DAILY'),
    pages: z.enum(['ALL', 'HOME', 'SHOPPING']).default('ALL'),
    device: z.enum(['ALL', 'MOBILE', 'DESKTOP']).default('ALL'),
    startsAt: z.iso.datetime({ offset: true }).nullish(),
    endsAt: z.iso.datetime({ offset: true }).nullish(),
    showCountdown: z.boolean().default(false),
    active: z.boolean().default(true),
    /** Lower shows first when several popups match the same page */
    priority: z.number().int().min(0).max(1000).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.layout !== 'TEXT' && !v.image) {
      ctx.addIssue({
        code: 'custom',
        path: ['image'],
        message: 'This layout needs an image',
      });
    }
    if (v.startsAt && v.endsAt && new Date(v.endsAt) <= new Date(v.startsAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'End time must be after the start time',
      });
    }
    if (v.showCountdown && !v.endsAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'Set an end time to show a countdown',
      });
    }
    if (v.cta && !v.href) {
      ctx.addIssue({
        code: 'custom',
        path: ['href'],
        message: 'A button needs a link',
      });
    }
  });
export type PopupInput = z.infer<typeof popupInputSchema>;

export const popupEventSchema = z.object({
  type: z.enum(['view', 'click']),
});
export type PopupEvent = z.infer<typeof popupEventSchema>;
