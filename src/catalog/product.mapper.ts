import type { Prisma } from '../generated/prisma/client.js';

/** Relations every product response needs */
export const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, slug: true } },
  brand: { select: { id: true, name: true, slug: true } },
  images: { orderBy: { sortOrder: 'asc' } },
  variants: { orderBy: { sortOrder: 'asc' } },
} as const satisfies Prisma.ProductInclude;

export type ProductRow = Prisma.ProductGetPayload<{
  include: typeof PRODUCT_INCLUDE;
}>;

/**
 * Shop-facing product — same shape as the frontend `Product` type.
 * Never includes costPrice or other admin-only fields.
 */
export function toPublicProduct(p: ProductRow) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    description: p.description,
    shortDescription: p.shortDescription ?? undefined,
    images: p.images.map((i) => ({ url: i.url, alt: i.alt ?? p.name })),
    price: p.price,
    comparePrice: p.comparePrice,
    stock: p.stock,
    category: p.category,
    brand: p.brand,
    variants: p.variants.length
      ? p.variants.map((v) => ({
          id: v.id,
          sku: v.sku,
          attributes: {
            ...(v.color ? { color: v.color } : {}),
            ...(v.size ? { size: v.size } : {}),
          },
          price: v.price ?? p.price,
          comparePrice: v.comparePrice ?? p.comparePrice,
          stock: v.stock,
        }))
      : undefined,
    rating: Math.round(p.ratingAvg * 10) / 10,
    reviewCount: p.reviewCount,
    isFeatured: p.isFeatured,
    isNew: p.isNew,
    createdAt: p.createdAt.toISOString(),
    // Lower-case like the frontend; "hidden" pages are noindex
    status: p.status.toLowerCase() as 'active' | 'hidden' | 'draft',
    metaTitle: p.metaTitle ?? undefined,
    metaDescription: p.metaDescription ?? undefined,
  };
}
export type PublicProduct = ReturnType<typeof toPublicProduct>;

/** Admin view: everything, including cost price and sales count */
export function toAdminProduct(p: ProductRow) {
  return {
    ...toPublicProduct(p),
    costPrice: p.costPrice,
    soldCount: p.soldCount,
    updatedAt: p.updatedAt.toISOString(),
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      color: v.color,
      size: v.size,
      price: v.price,
      comparePrice: v.comparePrice,
      stock: v.stock,
    })),
  };
}

export const paginated = <T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
) => ({
  data,
  meta: {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  },
});
