import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { PrismaService } from '../src/prisma/prisma.service.js';
import { adminToken, cleanupAdmins, createTestApp } from './helpers.js';

const TAG = `pop${Date.now().toString(36)}`;

const base = {
  name: `T ${TAG} Winter sale`,
  badge: 'Limited time',
  title: 'Winter Sale: up to 50% off',
  subtitle: 'Online only',
  image: 'https://images.unsplash.com/photo-1.jpg',
  cta: 'Shop now',
  href: '/products?onSale=1',
  layout: 'SPLIT',
  trigger: 'DELAY',
  delaySeconds: 3,
  frequency: 'DAILY',
  pages: 'ALL',
  device: 'ALL',
};

describe('Campaign popups (e2e)', () => {
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
    await prisma.popup.deleteMany({
      where: { name: { startsWith: `T ${TAG}` } },
    });
    await cleanupAdmins(app, TAG);
    await app.close();
  });

  it('staff cannot manage popups', async () => {
    await api()
      .get('/api/admin/popups')
      .set('Authorization', staff)
      .expect(403);
  });

  it('validates layout, link, schedule and coupon', async () => {
    const bad = async (patch: Record<string, unknown>) =>
      api()
        .post('/api/admin/popups')
        .set('Authorization', manager)
        .send({ ...base, ...patch })
        .expect(400);
    await bad({ image: null }); // SPLIT needs an image
    await bad({ href: '' }); // button without a link
    await bad({
      startsAt: '2030-01-02T00:00:00+06:00',
      endsAt: '2030-01-01T00:00:00+06:00',
    });
    await bad({ showCountdown: true }); // countdown without end time
    await bad({ couponCode: 'NO-SUCH-CODE' });
    // TEXT layout is fine without an image
    await api()
      .post('/api/admin/popups')
      .set('Authorization', manager)
      .send({ ...base, name: `T ${TAG} text`, layout: 'TEXT', image: '' })
      .expect(201);
  });

  it('create → public list → track → toggle → duplicate → delete', async () => {
    const created = await api()
      .post('/api/admin/popups')
      .set('Authorization', manager)
      .send({ ...base, couponCode: 'eid10' })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body.couponCode).toBe('EID10');

    // Public list hides admin-only fields
    const live = await api().get('/api/popups').expect(200);
    const mine = live.body.find((p: { id: string }) => p.id === id);
    expect(mine).toBeDefined();
    expect(mine.name).toBeUndefined();
    expect(mine.views).toBeUndefined();

    await api()
      .post(`/api/popups/${id}/events`)
      .send({ type: 'view' })
      .expect(204);
    await api()
      .post(`/api/popups/${id}/events`)
      .send({ type: 'click' })
      .expect(204);
    await api()
      .post(`/api/popups/${id}/events`)
      .send({ type: 'nope' })
      .expect(400);
    const stats = await prisma.popup.findUniqueOrThrow({ where: { id } });
    expect([stats.views, stats.clicks]).toEqual([1, 1]);

    // Turned off → gone from the shop
    await api()
      .patch(`/api/admin/popups/${id}/active`)
      .set('Authorization', manager)
      .send({ active: false })
      .expect(200);
    const after = await api().get('/api/popups').expect(200);
    expect(after.body.some((p: { id: string }) => p.id === id)).toBe(false);

    // Ended popups are not served either
    const ended = await api()
      .post('/api/admin/popups')
      .set('Authorization', manager)
      .send({
        ...base,
        name: `T ${TAG} ended`,
        startsAt: '2020-01-01T00:00:00+06:00',
        endsAt: '2020-01-02T00:00:00+06:00',
      })
      .expect(201);
    const live2 = await api().get('/api/popups').expect(200);
    expect(live2.body.some((p: { id: string }) => p.id === ended.body.id)).toBe(
      false,
    );

    const copy = await api()
      .post(`/api/admin/popups/${id}/duplicate`)
      .set('Authorization', manager)
      .expect(201);
    expect(copy.body).toMatchObject({
      active: false,
      views: 0,
      clicks: 0,
      title: base.title,
    });

    const reset = await api()
      .post(`/api/admin/popups/${id}/reset-stats`)
      .set('Authorization', manager)
      .expect(200);
    expect(reset.body.views).toBe(0);

    await api()
      .delete(`/api/admin/popups/${id}`)
      .set('Authorization', manager)
      .expect(204);
    await api()
      .put(`/api/admin/popups/${id}`)
      .set('Authorization', manager)
      .send(base)
      .expect(404);
  });
});
