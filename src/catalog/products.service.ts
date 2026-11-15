import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AdminProductQuery,
  COLLECTIONS,
  FacetQuery,
  ProductInput,
  ProductQuery,
} from './catalog.schemas.js';
import { CategoriesService } from './categories.service.js';
import {
  paginated,
  PRODUCT_INCLUDE,
  type ProductRow,
  toAdminProduct,
  toPublicProduct,
} from './product.mapper.js';

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
const sizeSort = (a: string, b: string) => {
  const ia = SIZE_ORDER.indexOf(a);
  const ib = SIZE_ORDER.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.localeCompare(b, undefined, { numeric: true });
};

/** "sky blue" → "Sky Blue" */
const titleCase = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const discountOf = (p: { price: number; comparePrice: number | null }) =>
  p.comparePrice && p.comparePrice > p.price
    ? (p.comparePrice - p.price) / p.comparePrice
    : 0;

export const LOW_STOCK = 5;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly activity: ActivityService,
  ) {}

  // ───────────────────────── Shop ─────────────────────────

  /** Category + search only: shared by the listing and its filter facets */
  private async baseWhere(q: {
    q?: string;
    category?: string;
  }): Promise<Prisma.ProductWhereInput> {
    const where: Prisma.ProductWhereInput = { status: 'ACTIVE' };
    if (q.category) {
      where.categoryId = { in: await this.categories.idsForSlug(q.category) };
    }
    if (q.q) {
      where.OR = [
        { name: { contains: q.q, mode: 'insensitive' } },
        { category: { name: { contains: q.q, mode: 'insensitive' } } },
        { brand: { name: { contains: q.q, mode: 'insensitive' } } },
      ];
    }
    return where;
  }

  async list(query: ProductQuery) {
    const where = await this.baseWhere(query);
    const and: Prisma.ProductWhereInput[] = [];
    if (query.min != null) and.push({ price: { gte: query.min } });
    if (query.max != null) and.push({ price: { lte: query.max } });
    if (query.ids?.length) and.push({ id: { in: query.ids } });
    if (query.stock) and.push({ stock: { gt: 0 } });
    if (query.sale) {
      and.push({ comparePrice: { gt: this.prisma.product.fields.price } });
    }
    if (query.size?.length) {
      and.push({
        variants: { some: { size: { in: query.size }, stock: { gt: 0 } } },
      });
    }
    if (query.color?.length) {
      and.push({
        variants: {
          some: { color: { in: query.color.map(titleCase) }, stock: { gt: 0 } },
        },
      });
    }
    if (and.length) where.AND = and;

    const { page, limit } = query;
    const skip = (page - 1) * limit;

    // Discount is computed, so sort ids in memory (catalog is small), then load the page
    if (query.sort === 'discount') {
      const all = await this.prisma.product.findMany({
        where,
        select: { id: true, price: true, comparePrice: true, createdAt: true },
      });
      all.sort(
        (a, b) =>
          discountOf(b) - discountOf(a) ||
          b.createdAt.getTime() - a.createdAt.getTime(),
      );
      const ids = all.slice(skip, skip + limit).map((p) => p.id);
      const rows = await this.prisma.product.findMany({
        where: { id: { in: ids } },
        include: PRODUCT_INCLUDE,
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      return paginated(
        ids.map((id) => toPublicProduct(byId.get(id)!)),
        all.length,
        page,
        limit,
      );
    }

    const orderBy: Prisma.ProductOrderByWithRelationInput[] =
      query.sort === 'price-asc'
        ? [{ price: 'asc' }]
        : query.sort === 'price-desc'
          ? [{ price: 'desc' }]
          : query.sort === 'popular'
            ? [{ soldCount: 'desc' }, { reviewCount: 'desc' }]
            : [{ createdAt: 'desc' }];
    orderBy.push({ id: 'asc' }); // stable pages

    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy,
        skip,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginated(rows.map(toPublicProduct), total, page, limit);
  }

  /** Filter sidebar options for the current category/search */
  async facets(query: FacetQuery) {
    const where = await this.baseWhere(query);
    const [byCategory, variants, price, allCategories] = await Promise.all([
      this.prisma.product.groupBy({
        by: ['categoryId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.productVariant.findMany({
        where: { product: where, stock: { gt: 0 } },
        select: { size: true, color: true },
        distinct: ['size', 'color'],
      }),
      this.prisma.product.aggregate({
        where,
        _min: { price: true },
        _max: { price: true },
      }),
      this.prisma.category.findMany({
        where: { active: true },
        select: {
          id: true,
          name: true,
          slug: true,
          parentId: true,
          sortOrder: true,
        },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    // Roll sub-category counts up into their top-level category
    const counts = new Map<string, number>();
    const directCounts = new Map<string, number>();
    for (const row of byCategory) {
      directCounts.set(row.categoryId, row._count._all);
      const cat = allCategories.find((c) => c.id === row.categoryId);
      const top = cat?.parentId ?? cat?.id;
      if (top) counts.set(top, (counts.get(top) ?? 0) + row._count._all);
    }
    const unique = (xs: (string | null)[]) => [
      ...new Set(xs.filter((x): x is string => Boolean(x))),
    ];

    // If querying a category that has sub-categories, return its sub-categories
    const currentCat = query.category
      ? allCategories.find((c) => c.slug === query.category)
      : null;
    const parentCat = currentCat?.parentId
      ? allCategories.find((c) => c.id === currentCat.parentId)
      : currentCat;

    const childCategories = parentCat
      ? allCategories.filter((c) => c.parentId === parentCat.id)
      : [];

    const categoriesList =
      childCategories.length > 0
        ? [
            {
              slug: parentCat!.slug,
              name: 'All',
              count: counts.get(parentCat!.id) ?? 0,
            },
            ...childCategories.map((c) => ({
              slug: c.slug,
              name: c.name,
              count: directCounts.get(c.id) ?? 0,
            })),
          ]
        : allCategories
            .filter((c) => !c.parentId && counts.get(c.id))
            .map((c) => ({ slug: c.slug, name: c.name, count: counts.get(c.id)! }));

    return {
      categories: categoriesList,
      sizes: unique(variants.map((v) => v.size)).sort(sizeSort),
      colors: unique(variants.map((v) => v.color)).sort(),
      priceRange: { min: price._min.price ?? 0, max: price._max.price ?? 0 },
    };
  }

  /** Active or hidden (direct link) products; drafts are never public */
  async bySlug(slug: string) {
    const row = await this.prisma.product.findFirst({
      where: { slug, status: { in: ['ACTIVE', 'HIDDEN'] } },
      include: PRODUCT_INCLUDE,
    });
    if (!row) throw new NotFoundException('Product not found');
    return toPublicProduct(row);
  }

  async related(slug: string, limit: number) {
    const product = await this.prisma.product.findFirst({
      where: { slug, status: { in: ['ACTIVE', 'HIDDEN'] } },
      select: { id: true, categoryId: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    const rows = await this.prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        categoryId: product.categoryId,
        id: { not: product.id },
      },
      include: PRODUCT_INCLUDE,
      orderBy: [{ soldCount: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
    return rows.map(toPublicProduct);
  }

  async collection(name: (typeof COLLECTIONS)[number], limit: number) {
    const base = { status: 'ACTIVE' as const };
    let rows: ProductRow[];
    switch (name) {
      case 'featured':
        rows = await this.prisma.product.findMany({
          where: { ...base, isFeatured: true },
          include: PRODUCT_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        break;
      case 'new-arrivals':
        rows = await this.prisma.product.findMany({
          where: { ...base, isNew: true },
          include: PRODUCT_INCLUDE,
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        break;
      case 'best-sellers':
        rows = await this.prisma.product.findMany({
          where: base,
          include: PRODUCT_INCLUDE,
          orderBy: [{ soldCount: 'desc' }, { reviewCount: 'desc' }],
          take: limit,
        });
        break;
      case 'flash-sale': {
        // Biggest discounts in stock (a scheduled campaign can replace this later)
        const onSale = await this.prisma.product.findMany({
          where: {
            ...base,
            stock: { gt: 0 },
            comparePrice: { gt: this.prisma.product.fields.price },
          },
          include: PRODUCT_INCLUDE,
        });
        rows = onSale
          .sort((a, b) => discountOf(b) - discountOf(a))
          .slice(0, limit);
        break;
      }
    }
    return rows.map(toPublicProduct);
  }

  /** Header search box */
  async suggest(q: string) {
    const rows = await this.prisma.product.findMany({
      where: { status: 'ACTIVE', name: { contains: q, mode: 'insensitive' } },
      select: {
        id: true,
        name: true,
        slug: true,
        price: true,
        images: {
          take: 1,
          orderBy: { sortOrder: 'asc' },
          select: { url: true },
        },
      },
      orderBy: { soldCount: 'desc' },
      take: 6,
    });
    return rows.map(({ images, ...p }) => ({ ...p, image: images[0]?.url }));
  }

  // ───────────────────────── Admin ─────────────────────────

  async adminList(query: AdminProductQuery) {
    const where: Prisma.ProductWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.categoryId) {
      where.OR = [
        { categoryId: query.categoryId },
        { category: { parentId: query.categoryId } },
      ];
    }
    if (query.lowStock) where.stock = { lte: LOW_STOCK };
    if (query.q) {
      where.AND = [
        {
          OR: [
            { name: { contains: query.q, mode: 'insensitive' } },
            { slug: { contains: query.q, mode: 'insensitive' } },
            { id: query.q },
            {
              variants: {
                some: { sku: { contains: query.q, mode: 'insensitive' } },
              },
            },
          ],
        },
      ];
    }
    const { page, limit } = query;
    const [rows, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        include: PRODUCT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.product.count({ where }),
    ]);
    return paginated(rows.map(toAdminProduct), total, page, limit);
  }

  async adminGet(id: string) {
    const row = await this.prisma.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    });
    if (!row) throw new NotFoundException('Product not found');
    return toAdminProduct(row);
  }

  async create(me: AdminPrincipal, dto: ProductInput) {
    await this.assertSlugFree(dto.slug);
    await this.assertCategory(dto.categoryId);
    const brandId = await this.brandId(dto.brand);
    const variants = normaliseVariants(dto.variants);

    const id = await this.prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          ...productFields(dto),
          brandId,
          stock: variants.length ? sumStock(variants) : dto.stock,
          images: { create: imageRows(dto) },
        },
        select: { id: true },
      });
      if (variants.length) {
        await tx.productVariant.createMany({
          data: variants.map((v, i) => ({
            ...v,
            productId: product.id,
            sku: skuFor(product.id, v),
            sortOrder: i,
          })),
        });
      }
      return product.id;
    });

    await this.activity.log(
      me,
      'product.create',
      `Added product "${dto.name}"${dto.status !== 'ACTIVE' ? ` (${dto.status.toLowerCase()})` : ''}`,
      `/admin/products/${id}`,
    );
    return this.adminGet(id);
  }

  /**
   * Full update. Variants are matched by id (or colour+size), so existing ones
   * keep their ids; rows missing from the input are deleted.
   */
  async update(me: AdminPrincipal, id: string, dto: ProductInput) {
    const existing = await this.prisma.product.findUnique({
      where: { id },
      include: { variants: true },
    });
    if (!existing) throw new NotFoundException('Product not found');
    if (dto.slug !== existing.slug) await this.assertSlugFree(dto.slug, id);
    await this.assertCategory(dto.categoryId);
    const brandId = await this.brandId(dto.brand);
    const variants = normaliseVariants(dto.variants);

    const keyOf = (v: { color: string | null; size: string | null }) =>
      `${v.color ?? ''}|${v.size ?? ''}`;
    const used = new Set<string>();
    const matched = variants.map((v) => {
      const prev =
        existing.variants.find((e) => e.id === v.id && !used.has(e.id)) ??
        existing.variants.find((e) => keyOf(e) === keyOf(v) && !used.has(e.id));
      if (prev) used.add(prev.id);
      return { input: v, prev };
    });
    const removed = existing.variants.filter((e) => !used.has(e.id));

    await this.prisma.$transaction(async (tx) => {
      await tx.product.update({
        where: { id },
        data: {
          ...productFields(dto),
          brandId,
          stock: variants.length ? sumStock(variants) : dto.stock,
        },
      });
      await tx.productImage.deleteMany({ where: { productId: id } });
      await tx.productImage.createMany({
        data: imageRows(dto).map((img) => ({ ...img, productId: id })),
      });
      if (removed.length) {
        await tx.productVariant.deleteMany({
          where: { id: { in: removed.map((r) => r.id) } },
        });
      }
      // Free the SKUs first: two variants swapping colour/size would otherwise
      // collide on the unique SKU halfway through
      for (const { prev } of matched) {
        if (prev) {
          await tx.productVariant.update({
            where: { id: prev.id },
            data: { sku: `${prev.id}-tmp` },
          });
        }
      }
      for (const [i, { input, prev }] of matched.entries()) {
        const { id: _ignored, ...data } = input;
        if (prev) {
          await tx.productVariant.update({
            where: { id: prev.id },
            data: { ...data, sku: skuFor(id, input), sortOrder: i },
          });
        } else {
          await tx.productVariant.create({
            data: {
              ...data,
              productId: id,
              sku: skuFor(id, input),
              sortOrder: i,
            },
          });
        }
      }
    });

    await this.activity.log(
      me,
      'product.update',
      `Updated product "${dto.name}"`,
      `/admin/products/${id}`,
    );
    return this.adminGet(id);
  }

  /** Order history keeps its own copy of name/price, so deleting is safe */
  async remove(me: AdminPrincipal, id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    await this.prisma.product.delete({ where: { id } });
    await this.activity.log(
      me,
      'product.delete',
      `Deleted product "${product.name}"`,
    );
  }

  private async assertSlugFree(slug: string, exceptId?: string) {
    const clash = await this.prisma.product.findFirst({
      where: { slug, NOT: exceptId ? { id: exceptId } : undefined },
      select: { id: true },
    });
    if (clash)
      throw new ConflictException(
        'This slug is already used by another product',
      );
  }

  private async assertCategory(id: string) {
    const ok = await this.prisma.category.count({ where: { id } });
    if (!ok) throw new BadRequestException('Category not found');
  }

  private async brandId(name: string | null | undefined) {
    const clean = name?.trim();
    if (!clean) return null;
    const slug = clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    if (!slug) return null;
    const brand = await this.prisma.brand.upsert({
      where: { slug },
      create: { name: clean, slug },
      update: {},
      select: { id: true },
    });
    return brand.id;
  }
}

// ───────── helpers ─────────

function productFields(dto: ProductInput) {
  return {
    name: dto.name,
    slug: dto.slug,
    description: dto.description,
    shortDescription: dto.shortDescription ?? null,
    categoryId: dto.categoryId,
    price: dto.price,
    comparePrice: dto.comparePrice ?? null,
    costPrice: dto.costPrice ?? null,
    status: dto.status,
    isFeatured: dto.isFeatured,
    isNew: dto.isNew,
    metaTitle: dto.metaTitle || null,
    metaDescription: dto.metaDescription || null,
  };
}

const imageRows = (dto: ProductInput) =>
  dto.images.map((img, i) => ({
    url: img.url,
    alt: img.alt || dto.name,
    sortOrder: i,
  }));

/** Colours in Title Case, sizes in upper case, empty → null */
function normaliseVariants(input: ProductInput['variants']) {
  return input.map((v) => ({
    id: v.id,
    color: v.color ? titleCase(v.color) : null,
    size: v.size ? v.size.trim().toUpperCase() : null,
    stock: v.stock,
    price: v.price ?? null,
    comparePrice: v.comparePrice ?? null,
  }));
}

const sumStock = (vs: { stock: number }[]) =>
  vs.reduce((s, v) => s + v.stock, 0);

/** Unique per product: "<ID>-MAROON-XL" */
const skuFor = (
  productId: string,
  v: { color: string | null; size: string | null },
) =>
  [productId.toUpperCase(), v.color?.toUpperCase().replace(/\s+/g, ''), v.size]
    .filter(Boolean)
    .join('-');
