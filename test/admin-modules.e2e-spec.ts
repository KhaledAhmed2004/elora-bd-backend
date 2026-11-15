import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { bdDay } from '../src/common/dates.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  adminToken,
  cleanupAdmins,
  createTestApp,
  freshIp,
} from './helpers.js';

const TAG = `adm${Date.now().toString(36)}`;
let seq = 0;
const phone = () =>
  `019${String(Date.now() % 100000).padStart(5, '0')}${String(seq++).padStart(3, '0')}`;

describe('Admin modules (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let manager: string;
  let staff: string;
  let productId: string;
  let slug: string;
  const phones: string[] = [];
  const api = () => request(app.getHttpServer());
  const newPhone = () => {
    const p = phone();
    phones.push(p);
    return p;
  };
  const address = (p: string) => ({
    fullName: 'Rina Test',
    phone: p,
    division: 'Dhaka',
    district: 'Dhaka',
    upazila: 'Mirpur',
    address: 'House 9, Road 3, Mirpur',
  });
  const stock = async () =>
    (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
      .stock;

  /** Places, confirms, ships and delivers an order; returns its id */
  async function deliveredOrder(p: string, quantity = 1) {
    const o = await api()
      .post('/api/orders')
      .set('X-Forwarded-For', freshIp())
      .send({
        items: [{ productId, quantity }],
        shippingAddress: address(p),
        paymentMethod: 'cod',
      })
      .expect(201);
    for (const status of ['confirmed', 'shipped', 'delivered']) {
      if (status === 'shipped') {
        await api()
          .post('/api/admin/orders/bulk/courier')
          .set('Authorization', staff)
          .send({ ids: [o.body.id], courier: 'Steadfast' })
          .expect(200);
        continue;
      }
      await api()
        .post(`/api/admin/orders/${o.body.id}/status`)
        .set('Authorization', staff)
        .send({ status })
        .expect(200);
    }
    return o.body.id as string;
  }

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    manager = await adminToken(app, 'MANAGER', TAG);
    staff = await adminToken(app, 'STAFF', TAG);
    const cat = await prisma.category.findUniqueOrThrow({
      where: { slug: 'bags' },
    });
    slug = `t-${TAG}-bag`;
    productId = (
      await prisma.product.create({
        data: {
          name: `Module Test Bag ${TAG}`,
          slug,
          description: 'Test product for admin modules',
          price: 800,
          costPrice: 500,
          stock: 20,
          categoryId: cat.id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { shipPhone: { in: phones } } });
    await prisma.incompleteOrder.deleteMany({
      where: { phone: { in: phones } },
    });
    await prisma.customer.deleteMany({ where: { phone: { in: phones } } });
    await prisma.purchase.deleteMany({
      where: { supplier: { name: { startsWith: `S ${TAG}` } } },
    });
    await prisma.supplier.deleteMany({
      where: { name: { startsWith: `S ${TAG}` } },
    });
    await prisma.expense.deleteMany({ where: { note: TAG } });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `t-${TAG}` } },
    });
    await cleanupAdmins(app, TAG);
    await app.close();
  });

  describe('reviews', () => {
    it('customer review waits for approval, then updates the product rating', async () => {
      const buyer = newPhone();
      await deliveredOrder(buyer);

      const res = await api()
        .post(`/api/products/${slug}/reviews`)
        .set('X-Forwarded-For', freshIp())
        .send({
          name: 'Rina',
          phone: buyer,
          rating: 4,
          text: 'Lovely bag, and the quality is great.',
        })
        .expect(201);
      expect(res.body.ok).toBe(true);
      await api()
        .post(`/api/products/${slug}/reviews`)
        .send({ name: 'X', rating: 9, text: 'short' })
        .expect(400);

      expect(
        (await api().get(`/api/products/${slug}/reviews`)).body,
      ).toHaveLength(0);

      const list = await api()
        .get(`/api/admin/reviews?status=pending&productId=${productId}`)
        .set('Authorization', staff)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        verified: true,
        status: 'pending',
        productSlug: slug,
      });
      expect(list.body.counts.pending).toBeGreaterThanOrEqual(1);
      const id = list.body.data[0].id as string;

      await api()
        .post('/api/admin/reviews/status')
        .set('Authorization', staff)
        .send({ ids: [id], status: 'approved' })
        .expect(200);
      await api()
        .patch(`/api/admin/reviews/${id}/reply`)
        .set('Authorization', staff)
        .send({ reply: 'Thank you so much!' })
        .expect(200);

      const shown = await api()
        .get(`/api/products/${slug}/reviews`)
        .expect(200);
      expect(shown.body[0]).toMatchObject({
        name: 'Rina',
        reply: 'Thank you so much!',
        verified: true,
      });
      const product = await api().get(`/api/products/${slug}`).expect(200);
      expect(product.body).toMatchObject({ rating: 4, reviewCount: 1 });

      await api()
        .post('/api/admin/reviews/status')
        .set('Authorization', staff)
        .send({ ids: [id], status: 'hidden' })
        .expect(200);
      expect((await api().get(`/api/products/${slug}`)).body.reviewCount).toBe(
        0,
      );
      await api()
        .delete('/api/admin/reviews')
        .set('Authorization', staff)
        .send({ ids: [id] })
        .expect(204);
    });
  });

  describe('incomplete orders', () => {
    it('lead → call note → recovered by a manual order', async () => {
      const p = newPhone();
      await api()
        .post('/api/checkout/lead')
        .send({
          phone: p,
          fullName: 'Lead Lady',
          district: 'Dhaka',
          items: [{ productId, quantity: 2 }],
        })
        .expect(200);

      const list = await api()
        .get(`/api/admin/incomplete-orders?q=${p}`)
        .set('Authorization', staff)
        .expect(200);
      expect(list.body.data[0]).toMatchObject({
        phone: p,
        status: 'open',
        subtotal: 1600,
      });
      expect(list.body.summary.waiting).toBeGreaterThanOrEqual(1);
      const leadId = list.body.data[0].id as string;

      await api()
        .post(`/api/admin/incomplete-orders/${leadId}/notes`)
        .set('Authorization', staff)
        .send({ note: 'Will order Friday' })
        .expect(200);
      const called = await api()
        .get(`/api/admin/incomplete-orders?q=${p}`)
        .set('Authorization', staff);
      expect(called.body.data[0]).toMatchObject({
        status: 'called',
        callNotes: [{ note: 'Will order Friday' }],
      });

      const order = await api()
        .post('/api/admin/orders')
        .set('Authorization', staff)
        .send({
          source: 'website',
          leadId,
          items: [{ productId, quantity: 2 }],
          shippingAddress: address(p),
        })
        .expect(201);
      const converted = await api()
        .get(`/api/admin/incomplete-orders?status=converted&q=${p}`)
        .set('Authorization', staff);
      expect(converted.body.data[0]).toMatchObject({
        status: 'converted',
        orderId: order.body.id,
      });
    });

    it('dismiss and re-open', async () => {
      const p = newPhone();
      await api()
        .post('/api/checkout/lead')
        .send({ phone: p, items: [{ productId, quantity: 1 }] })
        .expect(200);
      const lead = await prisma.incompleteOrder.findFirstOrThrow({
        where: { phone: p },
      });
      await api()
        .patch(`/api/admin/incomplete-orders/${lead.id}/status`)
        .set('Authorization', staff)
        .send({ status: 'dismissed' })
        .expect(200);
      const d = await api()
        .get(`/api/admin/incomplete-orders?status=dismissed&q=${p}`)
        .set('Authorization', staff);
      expect(d.body.data).toHaveLength(1);
      await api()
        .delete(`/api/admin/incomplete-orders/${lead.id}`)
        .set('Authorization', staff)
        .expect(204);
    });
  });

  describe('customers', () => {
    it('list, detail, tags and notes', async () => {
      const p = newPhone();
      await deliveredOrder(p, 2);
      const list = await api()
        .get(`/api/admin/customers?q=${p}`)
        .set('Authorization', staff)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        phone: p,
        orders: 1,
        spent: 1660,
        district: 'Dhaka',
      });

      await api()
        .put(`/api/admin/customers/${p}/tags`)
        .set('Authorization', staff)
        .send({ tags: ['VIP', 'VIP', 'Regular'] })
        .expect(200);
      const note = await api()
        .post(`/api/admin/customers/${p}/notes`)
        .set('Authorization', staff)
        .send({ text: 'Size L fits best' })
        .expect(201);

      const detail = await api()
        .get(`/api/admin/customers/${p}`)
        .set('Authorization', staff)
        .expect(200);
      expect(detail.body).toMatchObject({
        name: 'Rina Test',
        tags: ['VIP', 'Regular'],
        stats: { orders: 1, delivered: 1, spent: 1660 },
        risk: { level: 'good', successRate: 100 },
        notes: [{ text: 'Size L fits best', by: 'Test STAFF' }],
      });
      expect(detail.body.bought[0].qty).toBe(2);
      expect(detail.body.orders).toHaveLength(1);

      const tagged = await api()
        .get('/api/admin/customers?tag=VIP&limit=1000')
        .set('Authorization', staff);
      expect(tagged.body.data.map((c: { phone: string }) => c.phone)).toContain(
        p,
      );

      await api()
        .delete(`/api/admin/customers/${p}/notes/${note.body.id}`)
        .set('Authorization', staff)
        .expect(204);
      await api()
        .get('/api/admin/customers/01700000001')
        .set('Authorization', staff)
        .expect(404);
      await api()
        .get('/api/admin/customers/123')
        .set('Authorization', staff)
        .expect(400);
    });
  });

  describe('accounts', () => {
    it('only managers see money', async () => {
      await api()
        .get('/api/admin/expenses')
        .set('Authorization', staff)
        .expect(403);
      await api()
        .get('/api/admin/reports/profit-loss')
        .set('Authorization', staff)
        .expect(403);
      await api()
        .get('/api/admin/dashboard')
        .set('Authorization', staff)
        .expect(200);
    });

    it('expenses by date range', async () => {
      const today = bdDay(new Date());
      const e = await api()
        .post('/api/admin/expenses')
        .set('Authorization', manager)
        .send({ date: today, category: 'Facebook Ad', amount: 1234, note: TAG })
        .expect(201);
      const list = await api()
        .get(`/api/admin/expenses?from=${today}&to=${today}`)
        .set('Authorization', manager);
      expect(list.body.data.map((x: { id: string }) => x.id)).toContain(
        e.body.id,
      );
      const old = await api()
        .get('/api/admin/expenses?from=2020-01-01&to=2020-01-31')
        .set('Authorization', manager);
      expect(old.body.data.map((x: { id: string }) => x.id)).not.toContain(
        e.body.id,
      );
      await api()
        .get('/api/admin/expenses?from=2026-02-01&to=2026-01-01')
        .set('Authorization', manager)
        .expect(400);
    });

    it('purchase adds stock and sets cost; supplier due; delete reverses', async () => {
      const s = await api()
        .post('/api/admin/suppliers')
        .set('Authorization', manager)
        .send({ name: `S ${TAG} Islampur`, phone: '01711111111' })
        .expect(201);
      const before = await stock();
      const purchase = await api()
        .post('/api/admin/purchases')
        .set('Authorization', manager)
        .send({
          date: bdDay(new Date()),
          supplierId: s.body.id,
          lines: [{ productId, quantity: 10, unitCost: 450 }],
          paid: 1000,
        })
        .expect(201);
      expect(purchase.body.total).toBe(4500);
      expect(await stock()).toBe(before + 10);
      expect(
        (await prisma.product.findUniqueOrThrow({ where: { id: productId } }))
          .costPrice,
      ).toBe(450);

      await api()
        .post(`/api/admin/suppliers/${s.body.id}/payments`)
        .set('Authorization', manager)
        .send({ date: bdDay(new Date()), amount: 1500 })
        .expect(201);
      const ledger = await api()
        .get(`/api/admin/suppliers/${s.body.id}`)
        .set('Authorization', manager)
        .expect(200);
      expect(ledger.body).toMatchObject({
        bought: 4500,
        paid: 2500,
        due: 2000,
      });
      const all = await api()
        .get('/api/admin/suppliers')
        .set('Authorization', manager);
      expect(
        all.body.find((x: { id: string }) => x.id === s.body.id),
      ).toMatchObject({ due: 2000, purchases: 1 });

      await api()
        .delete(`/api/admin/suppliers/${s.body.id}`)
        .set('Authorization', manager)
        .expect(409);
      await api()
        .post('/api/admin/purchases')
        .set('Authorization', manager)
        .send({
          date: bdDay(new Date()),
          supplierId: s.body.id,
          lines: [{ productId, quantity: 1, unitCost: 100 }],
          paid: 500,
        })
        .expect(400);

      await api()
        .delete(`/api/admin/purchases/${purchase.body.id}`)
        .set('Authorization', manager)
        .expect(204);
      expect(await stock()).toBe(before);
    });
  });

  describe('reports', () => {
    it('dashboard, P&L, breakdown, courier, activity', async () => {
      await deliveredOrder(newPhone(), 3);

      const dash = await api()
        .get('/api/admin/dashboard')
        .set('Authorization', staff)
        .expect(200);
      expect(dash.body.revenueSeries).toHaveLength(14);
      expect(dash.body.revenueSeries.at(-1).date).toBe(bdDay(new Date()));
      expect(dash.body.todayOrders).toBeGreaterThan(0);
      expect(dash.body).toHaveProperty('lowStock');

      const today = bdDay(new Date());
      const pnl = await api()
        .get(`/api/admin/reports/profit-loss?from=${today}&to=${today}`)
        .set('Authorization', manager)
        .expect(200);
      expect(pnl.body.delivered).toBeGreaterThan(0);
      expect(pnl.body.netProfit).toBe(
        pnl.body.revenue -
          pnl.body.productCost -
          pnl.body.courierCost -
          pnl.body.expenses -
          pnl.body.refunds,
      );

      const byProduct = await api()
        .get(`/api/admin/reports/breakdown?by=product&from=${today}`)
        .set('Authorization', manager)
        .expect(200);
      const row = byProduct.body.find(
        (r: { key: string }) => r.key === productId,
      );
      // delivered here: 1 (reviews) + 2 (customers) + 3 (this test) = 6 bags
      expect(row).toMatchObject({ qty: 6, revenue: 4800, orders: 3 });

      const courier = await api()
        .get('/api/admin/reports/courier')
        .set('Authorization', manager)
        .expect(200);
      expect(
        courier.body.byCourier.map((c: { courier: string }) => c.courier),
      ).toContain('Steadfast');

      const activity = await api()
        .get('/api/admin/activity?group=stock&limit=10')
        .set('Authorization', manager)
        .expect(200);
      expect(
        activity.body.data.some((a: { message: string }) =>
          a.message.includes(`S ${TAG}`),
        ),
      ).toBe(true);
      await api()
        .get('/api/admin/activity')
        .set('Authorization', staff)
        .expect(403);
    });
  });
});
