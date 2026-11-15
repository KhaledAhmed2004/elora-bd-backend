import { Injectable } from '@nestjs/common';
import {
  AuthenticationStorage,
  type RefreshTokenRecord,
  type RefreshTokenStore,
} from '@nestjs/authentication';

import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

type Row = Awaited<
  ReturnType<PrismaService['refreshToken']['findUnique']>
> & {};

const toRecord = (r: Row): RefreshTokenRecord => ({
  id: r.id,
  familyId: r.familyId,
  userId: r.userId,
  createdAt: r.createdAt,
  expiresAt: r.expiresAt,
  familyExpiresAt: r.familyExpiresAt,
  // The contract wants absent optional fields, never null
  usedAt: r.usedAt ?? undefined,
  claims: (r.claims as Record<string, unknown> | null) ?? undefined,
});

/**
 * Refresh tokens in PostgreSQL for @nestjs/authentication's TokenService.
 * Rules (from RefreshTokenStore): one conditional write to mark a token used,
 * family revocation covers tokens saved later, times come from the caller.
 */
@Injectable()
export class PrismaRefreshTokenStore implements RefreshTokenStore {
  constructor(
    private readonly prisma: PrismaService,
    storage?: AuthenticationStorage,
  ) {
    storage?.registerSource({ refreshTokens: this });
  }

  async getRefreshToken(id: string) {
    const row = await this.prisma.refreshToken.findUnique({ where: { id } });
    return row ? toRecord(row) : undefined;
  }

  async saveRefreshToken(record: RefreshTokenRecord) {
    await this.prisma.refreshToken.create({
      data: {
        id: record.id,
        familyId: record.familyId,
        userId: record.userId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        familyExpiresAt: record.familyExpiresAt,
        usedAt: record.usedAt ?? null,
        claims: (record.claims as Prisma.InputJsonValue) ?? Prisma.DbNull,
      },
    });
    // Keep the tables bounded: families past their absolute lifetime are dead
    const now = record.createdAt;
    await this.prisma.refreshToken.deleteMany({
      where: { familyExpiresAt: { lt: now } },
    });
    await this.prisma.revokedTokenFamily.deleteMany({
      where: { familyExpiresAt: { lt: now } },
    });
  }

  async markRefreshTokenUsed(id: string, at: Date) {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: at },
    });
    return count === 1;
  }

  async revokeRefreshTokenFamily(familyId: string) {
    const token = await this.prisma.refreshToken.findFirst({
      where: { familyId },
      select: { familyExpiresAt: true },
    });
    // INSERT … ON CONFLICT DO NOTHING: concurrent revocations of one family
    // (parallel reuse) must not fail on the primary key, as upsert() would
    await this.prisma.revokedTokenFamily.createMany({
      data: {
        familyId,
        // Unknown family: keep the revocation for the longest possible family life
        familyExpiresAt:
          token?.familyExpiresAt ?? new Date(Date.now() + 366 * 86_400_000),
      },
      skipDuplicates: true,
    });
  }

  async isRefreshTokenFamilyRevoked(familyId: string) {
    const row = await this.prisma.revokedTokenFamily.findUnique({
      where: { familyId },
      select: { familyId: true },
    });
    return row !== null;
  }

  async revokeUserRefreshTokens(userId: string) {
    const families = await this.prisma.refreshToken.groupBy({
      by: ['familyId'],
      where: { userId },
      _max: { familyExpiresAt: true },
    });
    if (!families.length) return;
    await this.prisma.revokedTokenFamily.createMany({
      data: families.map((f) => ({
        familyId: f.familyId,
        familyExpiresAt: f._max.familyExpiresAt ?? new Date(),
      })),
      skipDuplicates: true,
    });
  }
}
