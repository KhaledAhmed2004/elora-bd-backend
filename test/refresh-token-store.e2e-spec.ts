import 'dotenv/config';

import { ConfigService } from '@nestjs/config';
import { authenticationStoreContract } from '@nestjs/authentication/testing';

import { PrismaRefreshTokenStore } from '../src/auth/prisma-refresh-token.store.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * The official @nestjs/authentication contract suite, run against our
 * PostgreSQL store — including the concurrency cases (two refreshes racing
 * with the same token must revoke the family).
 */
const prisma = new PrismaService(
  new ConfigService({ DATABASE_URL: process.env.DATABASE_URL }) as never,
);
const store = new PrismaRefreshTokenStore(prisma);

const cases = authenticationStoreContract(() => ({ refreshTokens: store }), {
  contracts: ['refreshTokens'],
  concurrent: true,
});

describe('PrismaRefreshTokenStore contract', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    await c.run();
  });
});
