import { z } from 'zod';

const slug = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Only lowercase letters, numbers and hyphens',
  );
const taka = z.number().int().min(0).max(10_000_000);
const optionalTaka = taka.nullish();
const url = z.url().max(2000);

/** "1" / "true" → true; anything else → undefined (query strings) */
const flag = z
  .enum(['1', 'true', '0', 'false'])
  .optional()
  .transform((v) => (v === '1' || v === 'true' ? true : undefined));

const csv = z
  .string()
  .max(200)
  .optional()
  .transform((s) =>
    s
      ? s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
      : undefined,
  );

// ───────── Public listing ─────────

export const PRODUCT_SORTS = [
  'newest',
  'popular',
  'price-asc',
  'price-desc',
  'discount',
] as const;

/** Same params as the shop URLs: ?q=&category=&min=&max=&size=M,L&stock=1&sale=1&sort=&page= */
export const productQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: slug.optional(),
  min: z.coerce.number().int().min(0).optional(),
  max: z.coerce.number().int().min(0).optional(),
  size: csv,
  color: csv,
  /** Specific products (wishlist), comma separated */
  ids: csv.refine((v) => !v || v.length <= 60, 'At most 60 ids'),
  stock: flag,
  sale: flag,
  sort: z.enum(PRODUCT_SORTS).default('newest'),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(12),
});
export type ProductQuery = z.infer<typeof productQuerySchema>;

export const facetQuerySchema = productQuerySchema.pick({
  q: true,
  category: true,
});
export type FacetQuery = z.infer<typeof facetQuerySchema>;

export const COLLECTIONS = [
  'featured',
  'new-arrivals',
  'best-sellers',
  'flash-sale',
] as const;
export const collectionParam = z.enum(COLLECTIONS);
export const limitQuery = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(8),
});
export const suggestQuery = z.object({
  q: z.string().trim().min(2).max(60),
});
export const slugParam = slug;
export const idParam = z.string().min(1).max(60);

// ───────── Admin: products ─────────

const variantInput = z.object({
  /** Existing variant id — keeps its id (and order history links) on edit */
  id: z.string().max(60).optional(),
  color: z.string().trim().max(30).nullish(),
  size: z.string().trim().max(20).nullish(),
  stock: z.number().int().min(0).max(1_000_000),
  /** null = use the product price */
  price: optionalTaka,
  comparePrice: optionalTaka,
});

export const productInputSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    slug,
    description: z.string().trim().min(10).max(10_000),
    shortDescription: z.string().trim().max(300).nullish(),
    categoryId: z.string().min(1).max(60),
    /** Brand name; created on the fly. Empty = no brand */
    brand: z.string().trim().max(60).nullish(),
    price: taka.min(1),
    comparePrice: optionalTaka,
    costPrice: optionalTaka,
    /** Used only when there are no variants */
    stock: z.number().int().min(0).max(1_000_000).default(0),
    variants: z.array(variantInput).max(200).default([]),
    images: z
      .array(z.object({ url, alt: z.string().trim().max(200).nullish() }))
      .min(1, 'At least one image is required')
      .max(20),
    status: z.enum(['ACTIVE', 'HIDDEN', 'DRAFT']).default('ACTIVE'),
    isFeatured: z.boolean().default(false),
    isNew: z.boolean().default(false),
    metaTitle: z.string().trim().max(70).nullish(),
    metaDescription: z.string().trim().max(160).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.comparePrice != null && v.comparePrice <= v.price) {
      ctx.addIssue({
        code: 'custom',
        path: ['comparePrice'],
        message: 'Compare-at price must be higher than the price',
      });
    }
    const keys = new Set<string>();
    v.variants.forEach((x, i) => {
      if (!x.color && !x.size) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', i],
          message: 'A variant needs a color or a size',
        });
      }
      const key = `${x.color?.toLowerCase() ?? ''}|${x.size?.toUpperCase() ?? ''}`;
      if (keys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['variants', i],
          message: 'The same color/size combination is listed twice',
        });
      }
      keys.add(key);
    });
  });
export type ProductInput = z.infer<typeof productInputSchema>;

export const adminProductQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: z.string().max(60).optional(),
  status: z.enum(['ACTIVE', 'HIDDEN', 'DRAFT']).optional(),
  lowStock: flag,
  page: z.coerce.number().int().min(1).default(1),
  /** Up to 500 so pickers (manual order, purchases) can load the catalog */
  limit: z.coerce.number().int().min(1).max(500).default(20),
});
export type AdminProductQuery = z.infer<typeof adminProductQuerySchema>;

// ───────── Admin: categories, banners, coupons ─────────

export const categoryInputSchema = z.object({
  name: z.string().trim().min(2).max(60),
  slug,
  image: url.nullish(),
  parentId: z.string().max(60).nullish(),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  active: z.boolean().default(true),
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;

export const bannerInputSchema = z.object({
  title: z.string().trim().min(2).max(80),
  subtitle: z.string().trim().max(160).nullish(),
  cta: z.string().trim().max(30).nullish(),
  /** Internal path ("/category/saree") or full URL */
  href: z
    .string()
    .trim()
    .max(500)
    .regex(/^(\/|https?:\/\/)/, 'Use a path like /category/saree or a full URL')
    .nullish(),
  image: url,
  active: z.boolean().default(true),
});
export type BannerInput = z.infer<typeof bannerInputSchema>;

export const reorderSchema = z.object({
  ids: z.array(z.string().max(60)).min(1).max(100),
});

export const couponInputSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(3)
      .max(30)
      .regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only')
      .transform((c) => c.toUpperCase()),
    description: z.string().trim().min(2).max(120),
    type: z.enum(['PERCENT', 'FIXED', 'FREE_SHIPPING']),
    value: z.number().int().min(0).max(1_000_000).default(0),
    minSubtotal: optionalTaka,
    maxDiscount: optionalTaka,
    usageLimit: z.number().int().min(1).max(1_000_000).nullish(),
    active: z.boolean().default(true),
    expiresAt: z.iso.datetime({ offset: true }).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'PERCENT' && (v.value < 1 || v.value > 90)) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Percent must be 1–90',
      });
    }
    if (v.type === 'FIXED' && v.value < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Enter the discount amount',
      });
    }
  });
export type CouponInput = z.infer<typeof couponInputSchema>;

export const couponCheckSchema = z.object({
  code: z.string().trim().min(1).max(30),
  subtotal: z.number().int().min(0).max(10_000_000),
});
export type CouponCheck = z.infer<typeof couponCheckSchema>;
