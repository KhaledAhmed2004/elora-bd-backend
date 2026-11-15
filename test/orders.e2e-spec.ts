import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { DEFAULT_STORE_SETTINGS } from '../src/settings/settings.defaults.js';
import {
  adminToken,
  cleanupAdmins,
  createTestApp,
  freshIp,
} from './helpers.js';

const TAG = `ord${Date.now().toString(36)}`;
let phoneSeq = 0;
/** Unique valid BD numbers per run */
const phone = () =>
  `018${String(Date.now() % 100000).padStart(5, '0')}${String(phoneSeq++).padStart(3, '0')}`;

const VALID_SETTINGS = {
  ...DEFAULT_STORE_SETTINGS,
  whatsapp: '8801712345678',
  advance: {
    mode: 'none',
    bkashNumber: '01712345678',
    nagadNumber: '01812345678',
  },
};

describe('Checkout & orders (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: string;
  let manager: string;
  let staff: string;
  let originalSettings: unknown;
  let productId: string; // variants: Red/M stock 2, Red/L stock 5
  let redM: string;
  let redL: string;
  let simpleId: string; // no variants, stock 3, price 500
  const phones: string[] = [];
  const api = () => request(app.getHttpServer());

  const address = (p: string, district = 'Dhaka') => ({
    fullName: 'Test Customer',
    phone: p,
    division: 'Dhaka',
    district,
    upazila: 'Mirpur',
    address: 'House 1, Road 2, Mirpur',
  });

  const place = (body: Record<string, unknown>) =>
    api().post('/api/orders').set('X-Forwarded-For', freshIp()).send(body);

  const newPhone = () => {
    const p = phone();
    phones.push(p);
    return p;
  };

  const stockOf = async () => ({
    redM: (
      await prisma.productVariant.findUniqueOrThrow({ where: { id: redM } })
    ).stock,
    redL: (
      await prisma.productVariant.findUniqueOrThrow({ where: { id: redL } })
    ).stock,
    product: (
      await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock,
  });

  const putSettings = (patch: Record<string, unknown>) =>
    api()
      .put('/api/admin/settings')
      .set('Authorization', owner)
      .send({ ...VALID_SETTINGS, ...patch })
      .expect(200);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    owner = await adminToken(app, 'OWNER', TAG);
    manager = await adminToken(app, 'MANAGER', TAG);
    staff = await adminToken(app, 'STAFF', TAG);
    originalSettings = (
      await prisma.setting.findUnique({ where: { key: 'store' } })
    )?.value;
    await putSettings({});

    const cat = await prisma.category.findUniqueOrThrow({
      where: { slug: 'kurti-tops' },
    });
    const p = await prisma.product.create({
      data: {
        name: 'Order Test Kurti',
        slug: `t-${TAG}-kurti`,
        description: 'Test product for order tests',
        price: 1000,
        costPrice: 600,
        stock: 7,
        categoryId: cat.id,
        variants: {
          create: [
            { sku: `${TAG}-RED-M`, color: 'Red', size: 'M', stock: 2 },
            {
              sku: `${TAG}-RED-L`,
              color: 'Red',
              size: 'L',
              stock: 5,
              price: 1100,
            },
          ],
        },
      },
      include: { variants: { orderBy: { size: 'desc' } } },
    });
    productId = p.id;
    redM = p.variants.find((v) => v.size === 'M')!.id;
    redL = p.variants.find((v) => v.size === 'L')!.id;
    simpleId = (
      await prisma.product.create({
        data: {
          name: 'Order Test Bag',
          slug: `t-${TAG}-bag`,
          description: 'Test product without variants',
          price: 500,
          stock: 3,
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
    await prisma.blacklist.deleteMany({ where: { phone: { in: phones } } });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `t-${TAG}` } },
    });
    await prisma.coupon.deleteMany({
      where: { code: { startsWith: TAG.toUpperCase() } },
    });
    await prisma.setting.update({
      where: { key: 'store' },
      data: { value: originalSettings as object },
    });
    await cleanupAdmins(app, TAG);
    await app.close();
  });

  describe('quote', () => {
    it('prices from the database, with delivery and coupon', async () => {
      const res = await api()
        .post('/api/checkout/quote')
        .send({
          items: [{ productId, variantId: redL, quantity: 1 }],
          district: 'Dhaka',
        })
        .expect(200);
      expect(res.body).toMatchObject({
        subtotal: 1100,
        deliveryCharge: 60,
        total: 1160,
      });

      const outside = await api()
        .post('/api/checkout/quote')
        .send({
          items: [{ productId, variantId: redL, quantity: 2 }],
          district: 'Rajshahi',
          couponCode: 'EID10',
        })
        .expect(200);
      // 2200 ≥ 2000 → free delivery; 10% off
      expect(outside.body).toMatchObject({
        subtotal: 2200,
        discount: 220,
        deliveryCharge: 0,
        total: 1980,
      });
      expect(JSON.stringify(outside.body)).not.toContain('costPrice');
    });

    it('reports stock and variant problems', async () => {
      const res = await api()
        .post('/api/checkout/quote')
        .send({
          items: [
            { productId, variantId: redM, quantity: 5 },
            { productId, quantity: 1 },
          ],
        })
        .expect(200);
      const reasons = res.body.problems.map(
        (p: { reason: string }) => p.reason,
      );
      expect(reasons).toEqual(
        expect.arrayContaining(['out-of-stock', 'variant-required']),
      );
    });
  });

  describe('placing orders', () => {
    it('ignores prices sent by the browser and keeps stock until confirmed', async () => {
      const p = newPhone();
      const res = await place({
        items: [{ productId, variantId: redL, quantity: 1, price: 1 }],
        shippingAddress: address(p),
        paymentMethod: 'cod',
        total: 1,
      }).expect(201);
      expect(res.body).toMatchObject({
        status: 'pending',
        subtotal: 1100,
        total: 1160,
      });
      expect(res.body.orderNumber).toMatch(/^BD-\d{6}$/);
      expect(JSON.stringify(res.body)).not.toMatch(
        /costPrice|adminNote|callLog/,
      );
      expect((await stockOf()).redL).toBe(5);
      const customer = await prisma.customer.findUnique({
        where: { phone: p },
      });
      expect(customer?.name).toBe('Test Customer');
    });

    it('converts the checkout lead into the order', async () => {
      const p = newPhone();
      await api()
        .post('/api/checkout/lead')
        .send({
          phone: p,
          fullName: 'Lead',
          items: [{ productId: simpleId, quantity: 1 }],
        })
        .expect(200);
      const lead = await prisma.incompleteOrder.findFirstOrThrow({
        where: { phone: p },
      });
      expect(lead).toMatchObject({ status: 'OPEN', subtotal: 500 });

      const order = await place({
        items: [{ productId: simpleId, quantity: 1 }],
        shippingAddress: address(p),
        paymentMethod: 'cod',
      }).expect(201);
      const after = await prisma.incompleteOrder.findUniqueOrThrow({
        where: { id: lead.id },
      });
      expect(after).toMatchObject({
        status: 'CONVERTED',
        orderId: order.body.id,
      });
    });

    it('blocks blacklisted numbers', async () => {
      const p = newPhone();
      await api()
        .post('/api/admin/blacklist')
        .set('Authorization', staff)
        .send({ phone: p, reason: 'Fake orders' })
        .expect(201);
      const res = await place({
        items: [{ productId: simpleId, quantity: 1 }],
        shippingAddress: address(p),
        paymentMethod: 'cod',
      }).expect(403);
      expect(res.body.message).toContain('call us');
    });

    it('refuses more than the stock, and disabled payment methods', async () => {
      await place({
        items: [{ productId, variantId: redM, quantity: 3 }],
        shippingAddress: address(newPhone()),
        paymentMethod: 'cod',
      }).expect(409);

      await putSettings({
        payments: { cod: true, bkash: true, nagad: true, sslcommerz: false },
      });
      await place({
        items: [{ productId: simpleId, quantity: 1 }],
        shippingAddress: address(newPhone()),
        paymentMethod: 'sslcommerz',
      }).expect(400);
      await putSettings({});
    });

    it('requires the advance outside Dhaka when the shop asks for it', async () => {
      await putSettings({
        advance: { ...VALID_SETTINGS.advance, mode: 'outside-dhaka' },
      });
      const base = {
        items: [{ productId: simpleId, quantity: 1 }],
        paymentMethod: 'cod',
      };
      const missing = await place({
        ...base,
        shippingAddress: address(newPhone(), 'Rajshahi'),
      }).expect(400);
      expect(missing.body.message).toContain('Transaction ID');

      const ok = await place({
        ...base,
        shippingAddress: address(newPhone(), 'Rajshahi'),
        advance: { method: 'bkash', trxId: 'abc123xyz' },
      }).expect(201);
      expect(ok.body.advance).toMatchObject({
        amount: 120,
        method: 'bkash',
        verified: false,
      });

      // Inside Dhaka needs no advance in this mode
      await place({
        ...base,
        shippingAddress: address(newPhone(), 'Dhaka'),
      }).expect(201);
      await putSettings({});
    });

    it('enforces a coupon usage limit', async () => {
      const code = `${TAG.toUpperCase()}ONE`;
      await api()
        .post('/api/admin/coupons')
        .set('Authorization', manager)
        .send({
          code,
          description: 'Once',
          type: 'FIXED',
          value: 50,
          usageLimit: 1,
        })
        .expect(201);
      const body = () => ({
        items: [{ productId: simpleId, quantity: 1 }],
        shippingAddress: address(newPhone()),
        paymentMethod: 'cod',
        couponCode: code,
      });
      const first = await place(body()).expect(201);
      expect(first.body.discount).toBe(50);
      await place(body()).expect(400);
    });

    it('tracks only with the matching phone', async () => {
      const p = newPhone();
      const order = await place({
        items: [{ productId: simpleId, quantity: 1 }],
        shippingAddress: address(p),
        paymentMethod: 'cod',
      }).expect(201);
      const ok = await api()
        .post('/api/orders/track')
        .send({
          orderNumber: order.body.orderNumber.toLowerCase(),
          phone: `+88${p}`,
        })
        .expect(200);
      expect(ok.body.status).toBe('pending');
      await api()
        .post('/api/orders/track')
        .send({ orderNumber: order.body.orderNumber, phone: '01700000000' })
        .expect(404);
    });
  });

  describe('admin workflow', () => {
    it('confirm takes stock, cancel puts it back, delivered counts as sold', async () => {
      const order = await place({
        items: [{ productId, variantId: redL, quantity: 2 }],
        shippingAddress: address(newPhone()),
        paymentMethod: 'cod',
      }).expect(201);
      const id = order.body.id as string;
      const before = await stockOf();

      await api()
        .post(`/api/admin/orders/${id}/calls`)
        .set('Authorization', staff)
        .send({ result: 'confirmed' })
        .expect(200);
      let s = await stockOf();
      expect(s.redL).toBe(before.redL - 2);
      expect(s.product).toBe(before.product - 2);

      await api()
        .post(`/api/admin/orders/${id}/status`)
        .set('Authorization', staff)
        .send({ status: 'cancelled', note: 'Customer changed mind' })
        .expect(200);
      expect((await stockOf()).redL).toBe(before.redL);

      await api()
        .post(`/api/admin/orders/${id}/status`)
        .set('Authorization', staff)
        .send({ status: 'confirmed' })
        .expect(200);
      const booked = await api()
        .post('/api/admin/orders/bulk/courier')
        .set('Authorization', staff)
        .send({ ids: [id], courier: 'Pathao' })
        .expect(200);
      expect(booked.body.booked).toEqual([id]);

      const delivered = await api()
        .post(`/api/admin/orders/${id}/status`)
        .set('Authorization', staff)
        .send({ status: 'delivered' })
        .expect(200);
      expect(delivered.body).toMatchObject({
        status: 'delivered',
        paymentStatus: 'paid',
      });
      expect(delivered.body.courier).toMatchObject({
        name: 'Pathao',
        charge: 60,
        settled: false,
      });
      expect(
        delivered.body.history.map((h: { status: string }) => h.status),
      ).toEqual([
        'pending',
        'confirmed',
        'cancelled',
        'confirmed',
        'shipped',
        'delivered',
      ]);
      expect(delivered.body.callLog[0]).toMatchObject({
        result: 'confirmed',
        by: 'Test STAFF',
      });
      const sold = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(sold.soldCount).toBeGreaterThanOrEqual(2);

      await api()
        .post(`/api/admin/orders/${id}/status`)
        .set('Authorization', staff)
        .send({ status: 'pending' })
        .expect(409);

      await api()
        .post('/api/admin/orders/bulk/settle')
        .set('Authorization', staff)
        .send({ ids: [id] })
        .expect(403);
      await api()
        .post('/api/admin/orders/bulk/settle')
        .set('Authorization', manager)
        .send({ ids: [id] })
        .expect(200);

      // Damaged return: no restock, partial refund
      await api()
        .post(`/api/admin/orders/${id}/return`)
        .set('Authorization', staff)
        .send({ reason: 'x' })
        .expect(403);
      const stockBeforeReturn = (await stockOf()).redL;
      const ret = await api()
        .post(`/api/admin/orders/${id}/return`)
        .set('Authorization', manager)
        .send({
          reason: 'Damaged in transit',
          restock: false,
          refundAmount: 500,
          refundMethod: 'bkash',
        })
        .expect(200);
      expect(ret.body).toMatchObject({
        status: 'returned',
        paymentStatus: 'refunded',
        refund: { amount: 500 },
      });
      expect((await stockOf()).redL).toBe(stockBeforeReturn);
    });

    it('two staff confirming orders for the last piece: only one wins', async () => {
      const left = (await stockOf()).redM;
      const make = () =>
        place({
          items: [{ productId, variantId: redM, quantity: left }],
          shippingAddress: address(newPhone()),
          paymentMethod: 'cod',
        }).expect(201);
      const [a, b] = await Promise.all([make(), make()]);
      const results = await Promise.all(
        [a, b].map((o) =>
          api()
            .post(`/api/admin/orders/${o.body.id}/status`)
            .set('Authorization', staff)
            .send({ status: 'confirmed' }),
        ),
      );
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        200, 409,
      ]);
      expect((await stockOf()).redM).toBe(0);
    });

    it('manual order with a bargain price, then edit re-syncs stock', async () => {
      const p = newPhone();
      const before = await stockOf();
      const res = await api()
        .post('/api/admin/orders')
        .set('Authorization', staff)
        .send({
          source: 'facebook',
          items: [{ productId, variantId: redL, quantity: 1, price: 900 }],
          shippingAddress: address(p, 'Khulna'),
          discount: 50,
        })
        .expect(201);
      expect(res.body).toMatchObject({
        status: 'confirmed',
        source: 'facebook',
        subtotal: 900,
        deliveryCharge: 120,
        total: 970,
      });
      expect(res.body.items[0].costPrice).toBe(600);
      expect((await stockOf()).redL).toBe(before.redL - 1);

      await api()
        .put(`/api/admin/orders/${res.body.id}`)
        .set('Authorization', staff)
        .send({
          source: 'facebook',
          items: [{ productId, variantId: redL, quantity: 3 }],
          shippingAddress: address(p, 'Khulna'),
          deliveryCharge: 100,
        })
        .expect(200);
      expect((await stockOf()).redL).toBe(before.redL - 3);

      const list = await api()
        .get(`/api/admin/orders?phone=${p}`)
        .set('Authorization', staff)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        total: 3400,
        risk: { level: 'new' },
      });
    });

    it('lists, counts and needs sign-in', async () => {
      await api().get('/api/admin/orders').expect(401);
      const counts = await api()
        .get('/api/admin/orders/counts')
        .set('Authorization', staff)
        .expect(200);
      expect(counts.body.all).toBeGreaterThan(0);
      const pending = await api()
        .get('/api/admin/orders?status=pending&limit=5')
        .set('Authorization', staff)
        .expect(200);
      expect(
        pending.body.data.every(
          (o: { status: string }) => o.status === 'pending',
        ),
      ).toBe(true);
    });

    it('only the owner changes settings', async () => {
      await api()
        .put('/api/admin/settings')
        .set('Authorization', manager)
        .send(VALID_SETTINGS)
        .expect(403);
      const pub = await api().get('/api/settings').expect(200);
      expect(pub.body).not.toHaveProperty('courierCharge');
      expect(pub.body.delivery.insideDhaka).toBe(60);
    });
  });
});
