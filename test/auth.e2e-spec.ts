import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';

import { hashPassword } from '../src/common/password.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp, freshIp, refreshCookie } from './helpers.js';

const RUN = Date.now().toString(36);
const OWNER = { email: `owner-${RUN}@test.local`, password: 'Owner-pass-123' };
const STAFF = { email: `staff-${RUN}@test.local`, password: 'Staff-pass-123' };

describe('Admin auth (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let staffId: string;

  const login = (email: string, password: string, ip = freshIp()) =>
    request(app.getHttpServer())
      .post('/api/admin/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ email, password });

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    await prisma.adminUser.create({
      data: {
        email: OWNER.email,
        name: 'Test Owner',
        role: 'OWNER',
        passwordHash: await hashPassword(OWNER.password),
      },
    });
  });

  afterAll(async () => {
    const admins = await prisma.adminUser.findMany({
      where: { email: { endsWith: `${RUN}@test.local` } },
      select: { id: true },
    });
    await prisma.refreshToken.deleteMany({
      where: { userId: { in: admins.map((a) => `admin:${a.id}`) } },
    });
    await prisma.adminUser.deleteMany({
      where: { id: { in: admins.map((a) => a.id) } },
    });
    await app.close();
  });

  it('rejects a wrong password with a generic message', async () => {
    const res = await login(OWNER.email, 'wrong-password-1').expect(401);
    expect(res.body.message).toBe('Email or password is incorrect');
    const unknown = await login(`nobody-${RUN}@test.local`, 'x').expect(401);
    expect(unknown.body.message).toBe(res.body.message);
  });

  it('validates the body', async () => {
    await login('not-an-email', '').expect(400);
  });

  it('logs in, sets an httpOnly refresh cookie, and /me works', async () => {
    const res = await login(OWNER.email.toUpperCase(), OWNER.password).expect(
      200,
    );
    expect(res.body.admin).toMatchObject({ email: OWNER.email, role: 'OWNER' });
    expect(res.body.accessToken).toEqual(expect.any(String));
    const raw = [res.headers['set-cookie']].flat().join(';');
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/admin\/auth/);
    ownerToken = res.body.accessToken;

    const me = await request(app.getHttpServer())
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(me.body.email).toBe(OWNER.email);
  });

  it('blocks protected routes without a token', async () => {
    await request(app.getHttpServer()).get('/api/admin/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/admin/staff').expect(401);
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });

  it('rotates the refresh token and detects reuse of a spent one', async () => {
    const res = await login(OWNER.email, OWNER.password).expect(200);
    const first = refreshCookie(res.headers['set-cookie'])!;

    const r1 = await request(app.getHttpServer())
      .post('/api/admin/auth/refresh')
      .set('Cookie', first)
      .expect(200);
    const second = refreshCookie(r1.headers['set-cookie'])!;
    expect(second).not.toBe(first);

    // The spent token comes back → theft assumed → whole family revoked
    await request(app.getHttpServer())
      .post('/api/admin/auth/refresh')
      .set('Cookie', first)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/admin/auth/refresh')
      .set('Cookie', second)
      .expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const res = await login(OWNER.email, OWNER.password).expect(200);
    const cookie = refreshCookie(res.headers['set-cookie'])!;
    await request(app.getHttpServer())
      .post('/api/admin/auth/logout')
      .set('Cookie', cookie)
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/admin/auth/refresh')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('owner creates staff; staff cannot manage staff', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Test Staff', role: 'STAFF', ...STAFF })
      .expect(201);
    expect(created.body).not.toHaveProperty('passwordHash');
    staffId = created.body.id;

    await request(app.getHttpServer())
      .post('/api/admin/staff')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Weak',
        role: 'STAFF',
        email: `weak-${RUN}@test.local`,
        password: 'short',
      })
      .expect(400);

    const staffLogin = await login(STAFF.email, STAFF.password).expect(200);
    const staffToken = staffLogin.body.accessToken as string;
    await request(app.getHttpServer())
      .get('/api/admin/staff')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
  });

  it('deactivating staff locks them out immediately', async () => {
    const staffLogin = await login(STAFF.email, STAFF.password).expect(200);
    const token = staffLogin.body.accessToken as string;
    const cookie = refreshCookie(staffLogin.headers['set-cookie'])!;

    await request(app.getHttpServer())
      .patch(`/api/admin/staff/${staffId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ active: false })
      .expect(200);

    await request(app.getHttpServer())
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/admin/auth/refresh')
      .set('Cookie', cookie)
      .expect(401);
    await login(STAFF.email, STAFF.password).expect(401);
  });

  it('owner cannot remove their own owner access', async () => {
    const me = await request(app.getHttpServer())
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${ownerToken}`);
    await request(app.getHttpServer())
      .patch(`/api/admin/staff/${me.body.id}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'STAFF' })
      .expect(400);
  });

  it('rate-limits login attempts from one IP', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++)
      await login(OWNER.email, 'wrong-password-1', ip).expect(401);
    await login(OWNER.email, OWNER.password, ip).expect(429);
  });

  it('change-password signs out other sessions', async () => {
    const other = await login(OWNER.email, OWNER.password).expect(200);
    const otherCookie = refreshCookie(other.headers['set-cookie'])!;
    const res = await request(app.getHttpServer())
      .post('/api/admin/auth/change-password')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Forwarded-For', freshIp())
      .send({
        currentPassword: OWNER.password,
        newPassword: 'New-owner-pass-456',
      })
      .expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    await request(app.getHttpServer())
      .post('/api/admin/auth/refresh')
      .set('Cookie', otherCookie)
      .expect(401);
    await login(OWNER.email, 'New-owner-pass-456').expect(200);
  });
});
