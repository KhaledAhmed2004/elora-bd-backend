import 'dotenv/config';

import { StandardSchemaValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';

import { AppModule } from '../src/app.module.js';

/** The app configured exactly like main.ts */
export async function createTestApp() {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  // Lets each test pick its own client IP (X-Forwarded-For) for the rate limiter
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  await app.init();
  return app;
}

let ipCounter = 1;
/** A fresh fake client IP, so login rate limits don't leak between tests */
export const freshIp = () =>
  `10.0.${Math.floor(ipCounter / 250)}.${ipCounter++ % 250}`;

/** "bd_admin_rt=…" from a Set-Cookie header */
export function refreshCookie(setCookie: string[] | string | undefined) {
  const list = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  const c = list.find((x) => x.startsWith('bd_admin_rt='));
  return c?.split(';')[0];
}

/** Creates an admin with this role and returns a Bearer token for it */
export async function adminToken(
  app: NestExpressApplication,
  role: 'OWNER' | 'MANAGER' | 'STAFF',
  tag: string,
) {
  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const { hashPassword } = await import('../src/common/password.js');
  const prisma = app.get(PrismaService);
  const email = `${role.toLowerCase()}-${tag}@test.local`;
  const password = `Pass-${tag}-123`;
  await prisma.adminUser.create({
    data: {
      email,
      name: `Test ${role}`,
      role,
      passwordHash: await hashPassword(password),
    },
  });
  const { default: request } = await import('supertest');
  const res = await request(app.getHttpServer())
    .post('/api/admin/auth/login')
    .set('X-Forwarded-For', freshIp())
    .send({ email, password })
    .expect(200);
  return `Bearer ${res.body.accessToken as string}`;
}

/** Removes the admins (and their tokens) created with this tag */
export async function cleanupAdmins(app: NestExpressApplication, tag: string) {
  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const prisma = app.get(PrismaService);
  const admins = await prisma.adminUser.findMany({
    where: { email: { endsWith: `${tag}@test.local` } },
    select: { id: true },
  });
  await prisma.refreshToken.deleteMany({
    where: { userId: { in: admins.map((a) => `admin:${a.id}`) } },
  });
  await prisma.adminUser.deleteMany({
    where: { id: { in: admins.map((a) => a.id) } },
  });
}
