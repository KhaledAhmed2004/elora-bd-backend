/**
 * Development seed — same catalog the frontend mock data uses (ids are kept, so
 * the frontend can switch to the API without broken links).
 * Safe to run again: everything is upserted.  Run: npx prisma db seed
 */
import 'dotenv/config';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';

import { hashPassword } from '../src/common/password.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { DEFAULT_STORE_SETTINGS } from '../src/settings/settings.defaults.js';

interface SeedCategory {
  id: string;
  name: string;
  slug: string;
  image?: string;
  parentId?: string;
  children?: SeedCategory[];
}
interface SeedProduct {
  id: string;
  name: string;
  slug: string;
  description: string;
  shortDescription?: string;
  images: { url: string; alt?: string }[];
  price: number;
  comparePrice?: number | null;
  costPrice?: number;
  stock: number;
  category: { id: string };
  brand?: { id: string; name: string; slug: string } | null;
  variants?: {
    id: string;
    sku: string;
    attributes: { color?: string; size?: string };
    price: number;
    comparePrice?: number | null;
    stock: number;
  }[];
  rating?: number;
  reviewCount?: number;
  isFeatured?: boolean;
  isNew?: boolean;
  createdAt: string;
}
interface SeedReview {
  id: string;
  productId: string;
  name: string;
  rating: number;
  text: string;
  date: string;
  verified: boolean;
}
interface SeedData {
  reviews: SeedReview[];
  categories: SeedCategory[];
  products: SeedProduct[];
  banners: {
    id: string;
    title: string;
    subtitle: string;
    cta: string;
    href: string;
    image: string;
  }[];
}

const data = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'seed-data.json'), 'utf8'),
) as SeedData;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function seedAdmin() {
  const email = (
    process.env.SEED_ADMIN_EMAIL ?? 'admin@bdshop.com'
  ).toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error('Set SEED_ADMIN_PASSWORD (10+ characters) in backend/.env');
  }
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing)
    return console.log(`• Owner ${email} already exists (password unchanged)`);
  await prisma.adminUser.create({
    data: {
      email,
      name: 'Shop Owner',
      role: 'OWNER',
      passwordHash: await hashPassword(password),
    },
  });
  console.log(`• Owner account created: ${email}`);
}

async function seedCategories() {
  let order = 0;
  for (const parent of data.categories) {
    const row = {
      name: parent.name,
      slug: parent.slug,
      image: parent.image,
      sortOrder: order++,
    };
    await prisma.category.upsert({
      where: { id: parent.id },
      create: { id: parent.id, ...row },
      update: row,
    });
    for (const [i, child] of (parent.children ?? []).entries()) {
      const c = {
        name: child.name,
        slug: child.slug,
        parentId: parent.id,
        sortOrder: i,
      };
      await prisma.category.upsert({
        where: { id: child.id },
        create: { id: child.id, ...c },
        update: c,
      });
    }
  }
  console.log(`• ${await prisma.category.count()} categories`);
}

async function seedProducts() {
  for (const p of data.products) {
    if (p.brand) {
      await prisma.brand.upsert({
        where: { id: p.brand.id },
        create: { id: p.brand.id, name: p.brand.name, slug: p.brand.slug },
        update: { name: p.brand.name },
      });
    }
    const row = {
      name: p.name,
      slug: p.slug,
      description: p.description,
      shortDescription: p.shortDescription,
      price: p.price,
      comparePrice: p.comparePrice ?? null,
      costPrice: p.costPrice ?? null,
      stock: p.stock,
      isFeatured: p.isFeatured ?? false,
      isNew: p.isNew ?? false,
      ratingAvg: p.rating ?? 0,
      reviewCount: p.reviewCount ?? 0,
      categoryId: p.category.id,
      brandId: p.brand?.id ?? null,
    };
    await prisma.$transaction([
      prisma.product.upsert({
        where: { id: p.id },
        create: { id: p.id, createdAt: new Date(p.createdAt), ...row },
        update: row,
      }),
      prisma.productImage.deleteMany({ where: { productId: p.id } }),
      prisma.productImage.createMany({
        data: p.images.map((img, i) => ({
          productId: p.id,
          url: img.url,
          alt: img.alt ?? p.name,
          sortOrder: i,
        })),
      }),
      prisma.productVariant.deleteMany({ where: { productId: p.id } }),
      prisma.productVariant.createMany({
        data: (p.variants ?? []).map((v, i) => ({
          id: v.id,
          productId: p.id,
          sku: v.sku,
          color: v.attributes.color ?? null,
          size: v.attributes.size ?? null,
          // Same as the product price → store null ("use product price")
          price: v.price === p.price ? null : v.price,
          comparePrice: v.comparePrice ?? null,
          stock: v.stock,
          sortOrder: i,
        })),
      }),
    ]);
  }
  console.log(
    `• ${await prisma.product.count()} products, ${await prisma.productVariant.count()} variants`,
  );
}

async function seedContent() {
  for (const [i, b] of data.banners.entries()) {
    const row = { ...b, sortOrder: i, active: true };
    await prisma.banner.upsert({
      where: { id: b.id },
      create: row,
      update: row,
    });
  }
  const coupons = [
    {
      code: 'EID10',
      description: '10% chhar (shorbochcho ৳500)',
      type: 'PERCENT',
      value: 10,
      maxDiscount: 500,
    },
    {
      code: 'WELCOME100',
      description: '৳1,000+ order e ৳100 chhar',
      type: 'FIXED',
      value: 100,
      minSubtotal: 1000,
    },
    {
      code: 'FREESHIP',
      description: 'Free delivery',
      type: 'FREE_SHIPPING',
      value: 0,
    },
  ] as const;
  for (const c of coupons) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      create: c,
      update: {},
    });
  }
  await prisma.setting.upsert({
    where: { key: 'store' },
    create: { key: 'store', value: DEFAULT_STORE_SETTINGS },
    update: {},
  });
  console.log(
    `• ${data.banners.length} banners, ${coupons.length} coupons, store settings`,
  );
}

/** Demo reviews (approved), then each product's rating is computed from real rows */
async function seedReviews() {
  for (const r of data.reviews) {
    const row = {
      productId: r.productId,
      name: r.name,
      rating: r.rating,
      text: r.text,
      verified: r.verified,
      status: 'APPROVED' as const,
      createdAt: new Date(r.date),
    };
    await prisma.review.upsert({
      where: { id: r.id },
      create: { id: r.id, ...row },
      update: {},
    });
  }
  const stats = await prisma.review.groupBy({
    by: ['productId'],
    where: { status: 'APPROVED' },
    _avg: { rating: true },
    _count: { _all: true },
  });
  for (const s of stats) {
    await prisma.product.update({
      where: { id: s.productId },
      data: {
        ratingAvg: s._avg.rating ?? 0,
        reviewCount: s._count._all,
      },
    });
  }
  console.log(`• ${data.reviews.length} reviews`);
}

try {
  await seedAdmin();
  await seedCategories();
  await seedProducts();
  await seedContent();
  await seedReviews();
  console.log('Seed complete ✔');
} finally {
  await prisma.$disconnect();
}
