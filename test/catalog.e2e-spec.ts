import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { adminToken, cleanupAdmins, createTestApp } from './helpers.js';

/** Needs the seeded catalog (npm run db:seed) */
const TAG = `cat${Date.now().toString(36)}`;

interface P {
  id: string;
  slug: string;
  price: number;
  comparePrice: number | null;
  stock: number;
  category: { slug: string };
  variants?: {
    id: string;
    sku: string;
    attributes: { color?: string; size?: string };
    stock: number;
  }[];
}

describe('Catalog (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let manager: string;
  let staff: string;
  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    manager = await adminToken(app, 'MANAGER', TAG);
    staff = await adminToken(app, 'STAFF', TAG);
  });

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `t-${TAG}` } },
    });
    await prisma.category.deleteMany({
      where: { slug: { startsWith: `t-${TAG}` }, parentId: { not: null } },
    });
    await prisma.category.deleteMany({
      where: { slug: { startsWith: `t-${TAG}` } },
    });
    await prisma.banner.deleteMany({
      where: { title: { startsWith: `T ${TAG}` } },
    });
    await prisma.coupon.deleteMany({
      where: { code: { startsWith: TAG.toUpperCase() } },
    });
    await cleanupAdmins(app, TAG);
    await app.close();
  });

  describe('shop (public)', () => {
    it('category tree with sub-categories', async () => {
      const res = await api().get('/api/categories').expect(200);
      const saree = res.body.find((c: { slug: string }) => c.slug === 'saree');
      expect(saree.children.length).toBeGreaterThan(0);
      const one = await api().get('/api/categories/saree-jamdani').expect(200);
      expect(one.body.parent.slug).toBe('saree');
      await api().get('/api/categories/nope').expect(404);
    });

    it('paginates and never leaks cost price', async () => {
      const res = await api().get('/api/products?limit=5&page=2').expect(200);
      expect(res.body.data).toHaveLength(5);
      expect(res.body.meta).toMatchObject({ page: 2, limit: 5 });
      expect(res.body.meta.total).toBeGreaterThanOrEqual(36);
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('costPrice');
      expect(raw).not.toContain('soldCount');
    });

    it('filters by category, size, colour, sale and price', async () => {
      const cat = await api()
        .get('/api/products?category=salwar-kameez&limit=60')
        .expect(200);
      expect(cat.body.data.length).toBeGreaterThan(0);
      expect(
        cat.body.data.every((p: P) => p.category.slug === 'salwar-kameez'),
      ).toBe(true);

      const size = await api()
        .get('/api/products?size=XXL&limit=60')
        .expect(200);
      expect(
        size.body.data.every((p: P) =>
          p.variants?.some((v) => v.attributes.size === 'XXL' && v.stock > 0),
        ),
      ).toBe(true);

      const color = await api().get('/api/products?color=navy').expect(200);
      expect(color.body.data.map((p: P) => p.slug)).toContain(
        'georgette-anarkali-three-piece',
      );

      const sale = await api().get('/api/products?sale=1&limit=60').expect(200);
      expect(sale.body.data.every((p: P) => p.comparePrice! > p.price)).toBe(
        true,
      );

      const price = await api()
        .get('/api/products?min=1000&max=2000&limit=60')
        .expect(200);
      expect(
        price.body.data.every((p: P) => p.price >= 1000 && p.price <= 2000),
      ).toBe(true);

      await api().get('/api/products?sort=bogus').expect(400);
    });

    it('sorts by price and by discount', async () => {
      const asc = await api()
        .get('/api/products?sort=price-asc&limit=60')
        .expect(200);
      const prices = asc.body.data.map((p: P) => p.price);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));

      const disc = await api()
        .get('/api/products?sort=discount&limit=60')
        .expect(200);
      const d = disc.body.data.map((p: P) =>
        p.comparePrice ? (p.comparePrice - p.price) / p.comparePrice : 0,
      );
      expect(d).toEqual([...d].sort((a, b) => b - a));
    });

    it('search, facets, suggestions', async () => {
      const s = await api().get('/api/products?q=jamdani').expect(200);
      expect(s.body.data.length).toBeGreaterThan(0);
      const f = await api()
        .get('/api/products/facets?category=salwar-kameez')
        .expect(200);
      expect(f.body.sizes).toEqual(['M', 'L', 'XL', 'XXL']);
      expect(f.body.colors).toEqual(expect.arrayContaining(['Navy', 'Maroon']));
      const sug = await api().get('/api/products/suggest?q=saree').expect(200);
      expect(sug.body.length).toBeGreaterThan(0);
      expect(sug.body[0]).toHaveProperty('image');
    });

    it('product page, related, collections, banners', async () => {
      const p = await api()
        .get('/api/products/georgette-anarkali-three-piece')
        .expect(200);
      expect(p.body.variants[0].attributes).toEqual({
        color: 'Maroon',
        size: 'M',
      });
      await api().get('/api/products/does-not-exist').expect(404);
      const rel = await api()
        .get('/api/products/georgette-anarkali-three-piece/related?limit=3')
        .expect(200);
      expect(rel.body.length).toBeLessThanOrEqual(3);
      for (const c of [
        'featured',
        'new-arrivals',
        'best-sellers',
        'flash-sale',
      ]) {
        const r = await api()
          .get(`/api/products/collections/${c}?limit=4`)
          .expect(200);
        expect(r.body.length).toBeGreaterThan(0);
      }
      await api().get('/api/products/collections/unknown').expect(400);
      const b = await api().get('/api/banners').expect(200);
      expect(b.body.length).toBeGreaterThanOrEqual(3);
    });

    it('coupon check', async () => {
      const ok = await api()
        .post('/api/coupons/check')
        .send({ code: 'eid10', subtotal: 3000 })
        .expect(200);
      expect(ok.body).toMatchObject({ ok: true, discount: 300 });
      const capped = await api()
        .post('/api/coupons/check')
        .send({ code: 'EID10', subtotal: 10000 });
      expect(capped.body.discount).toBe(500);
      const min = await api()
        .post('/api/coupons/check')
        .send({ code: 'WELCOME100', subtotal: 500 });
      expect(min.body.ok).toBe(false);
      const bad = await api()
        .post('/api/coupons/check')
        .send({ code: 'NOPE', subtotal: 500 });
      expect(bad.body).toEqual({
        ok: false,
        error: 'This coupon code is not valid',
      });
    });
  });

  describe('admin', () => {
    const slug = `t-${TAG}-kurti`;
    let productId: string;
    let categoryId: string;

    const body = (over: Record<string, unknown> = {}) => ({
      name: 'Test Linen Kurti',
      slug,
      description: 'Soft linen kurti for everyday wear.',
      categoryId,
      brand: 'Test Brand',
      price: 1500,
      comparePrice: 1800,
      costPrice: 900,
      images: [
        { url: 'https://images.unsplash.com/photo-1583391733956-3750e0ff4e8b' },
      ],
      variants: [
        { color: 'red', size: 'm', stock: 3 },
        { color: 'red', size: 'l', stock: 4 },
        { color: 'sky blue', size: 'm', stock: 5 },
      ],
      ...over,
    });

    beforeAll(async () => {
      categoryId = (
        await prisma.category.findUniqueOrThrow({
          where: { slug: 'kurti-tops' },
        })
      ).id;
    });

    it('requires sign-in and the right role', async () => {
      await api().get('/api/admin/products').expect(401);
      const list = await api()
        .get('/api/admin/products?limit=2')
        .set('Authorization', staff)
        .expect(200);
      expect(list.body.data[0]).toHaveProperty('costPrice');
      await api()
        .post('/api/admin/products')
        .set('Authorization', staff)
        .send(body())
        .expect(403);
    });

    it('validates input', async () => {
      await api()
        .post('/api/admin/products')
        .set('Authorization', manager)
        .send(body({ comparePrice: 1000 }))
        .expect(400);
      await api()
        .post('/api/admin/products')
        .set('Authorization', manager)
        .send(
          body({
            variants: [
              { color: 'Red', stock: 1 },
              { color: 'red', stock: 2 },
            ],
          }),
        )
        .expect(400);
    });

    it('creates a product with colour × size variants', async () => {
      const res = await api()
        .post('/api/admin/products')
        .set('Authorization', manager)
        .send(body())
        .expect(201);
      productId = res.body.id;
      expect(res.body.stock).toBe(12);
      expect(res.body.costPrice).toBe(900);
      expect(res.body.brand.name).toBe('Test Brand');
      expect(
        res.body.variants.map(
          (v: { color: string; size: string }) => `${v.color}/${v.size}`,
        ),
      ).toEqual(['Red/M', 'Red/L', 'Sky Blue/M']);
      expect(res.body.variants[2].sku).toBe(
        `${productId.toUpperCase()}-SKYBLUE-M`,
      );
      await api()
        .post('/api/admin/products')
        .set('Authorization', manager)
        .send(body())
        .expect(409);
      await api().get(`/api/products/${slug}`).expect(200);
    });

    it('updates variants keeping ids for unchanged colour/size', async () => {
      const before = await api()
        .get(`/api/admin/products/${productId}`)
        .set('Authorization', manager);
      const redM = before.body.variants[0].id;
      const res = await api()
        .put(`/api/admin/products/${productId}`)
        .set('Authorization', manager)
        .send(
          body({
            variants: [
              { id: redM, color: 'Red', size: 'M', stock: 10 },
              { color: 'Black', size: 'XL', stock: 1 },
            ],
          }),
        )
        .expect(200);
      expect(res.body.variants[0].id).toBe(redM);
      expect(res.body.variants).toHaveLength(2);
      expect(res.body.stock).toBe(11);
    });

    it('draft and hidden visibility', async () => {
      await api()
        .put(`/api/admin/products/${productId}`)
        .set('Authorization', manager)
        .send(body({ status: 'DRAFT' }))
        .expect(200);
      await api().get(`/api/products/${slug}`).expect(404);

      await api()
        .put(`/api/admin/products/${productId}`)
        .set('Authorization', manager)
        .send(body({ status: 'HIDDEN' }))
        .expect(200);
      const page = await api().get(`/api/products/${slug}`).expect(200);
      expect(page.body.status).toBe('hidden');
      const listed = await api()
        .get('/api/products?q=Test Linen Kurti')
        .expect(200);
      expect(listed.body.data).toHaveLength(0);
    });

    it('deletes a product', async () => {
      await api()
        .delete(`/api/admin/products/${productId}`)
        .set('Authorization', manager)
        .expect(204);
      await api()
        .get(`/api/admin/products/${productId}`)
        .set('Authorization', manager)
        .expect(404);
    });

    it('categories: two levels only, cannot delete one in use', async () => {
      const parent = await api()
        .post('/api/admin/categories')
        .set('Authorization', manager)
        .send({ name: 'Test Parent', slug: `t-${TAG}-parent` })
        .expect(201);
      const child = await api()
        .post('/api/admin/categories')
        .set('Authorization', manager)
        .send({
          name: 'Test Child',
          slug: `t-${TAG}-child`,
          parentId: parent.body.id,
        })
        .expect(201);
      await api()
        .post('/api/admin/categories')
        .set('Authorization', manager)
        .send({
          name: 'Too Deep',
          slug: `t-${TAG}-deep`,
          parentId: child.body.id,
        })
        .expect(400);
      await api()
        .delete(`/api/admin/categories/${parent.body.id}`)
        .set('Authorization', manager)
        .expect(409);
      await api()
        .delete(`/api/admin/categories/${categoryId}`)
        .set('Authorization', manager)
        .expect(409);
      await api()
        .delete(`/api/admin/categories/${child.body.id}`)
        .set('Authorization', manager)
        .expect(204);
    });

    it('banners: create, reorder, staff blocked', async () => {
      await api()
        .get('/api/admin/banners')
        .set('Authorization', staff)
        .expect(403);
      const b = await api()
        .post('/api/admin/banners')
        .set('Authorization', manager)
        .send({
          title: `T ${TAG}`,
          image: 'https://example.com/b.jpg',
          href: '/category/saree',
        })
        .expect(201);
      const all = await api()
        .get('/api/admin/banners')
        .set('Authorization', manager);
      const ids = all.body.map((x: { id: string }) => x.id);
      const reordered = await api()
        .patch('/api/admin/banners/order')
        .set('Authorization', manager)
        .send({
          ids: [b.body.id, ...ids.filter((i: string) => i !== b.body.id)],
        })
        .expect(200);
      expect(reordered.body[0].id).toBe(b.body.id);
      await api()
        .post('/api/admin/banners')
        .set('Authorization', manager)
        .send({
          title: `T ${TAG} bad`,
          image: 'https://example.com/b.jpg',
          href: 'javascript:alert(1)',
        })
        .expect(400);
    });

    it('coupons: create, validate rules, use in check', async () => {
      const code = `${TAG.toUpperCase()}X`;
      await api()
        .post('/api/admin/coupons')
        .set('Authorization', manager)
        .send({ code, description: 'Test', type: 'PERCENT', value: 95 })
        .expect(400);
      await api()
        .post('/api/admin/coupons')
        .set('Authorization', manager)
        .send({
          code: code.toLowerCase(),
          description: 'Test',
          type: 'FIXED',
          value: 150,
          usageLimit: 1,
        })
        .expect(201);
      const check = await api()
        .post('/api/coupons/check')
        .send({ code, subtotal: 100 });
      expect(check.body.discount).toBe(100);
      await api()
        .put(`/api/admin/coupons/${code}`)
        .set('Authorization', manager)
        .send({
          code,
          description: 'Off',
          type: 'FIXED',
          value: 150,
          active: false,
        })
        .expect(200);
      const off = await api()
        .post('/api/coupons/check')
        .send({ code, subtotal: 1000 });
      expect(off.body.ok).toBe(false);
      await api()
        .delete(`/api/admin/coupons/${code}`)
        .set('Authorization', manager)
        .expect(204);
    });
  });
});
