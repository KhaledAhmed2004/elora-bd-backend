import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

export type RiskLevel = 'blacklisted' | 'risky' | 'new' | 'good';

export interface CustomerRisk {
  level: RiskLevel;
  /** This shop's own history with the number */
  own: {
    total: number;
    delivered: number;
    returned: number;
    cancelled: number;
  };
  /** Courier-network history — null until a courier fraud-check API is connected (step 7) */
  courier: { total: number; delivered: number; returned: number } | null;
  /** Delivered ÷ (delivered + returned), 0–100; null with no history */
  successRate: number | null;
  blacklistReason?: string;
}

/** Fake-order risk per phone number, from real order history */
@Injectable()
export class RiskService {
  constructor(private readonly prisma: PrismaService) {}

  async forPhones(phones: string[]): Promise<Map<string, CustomerRisk>> {
    const unique = [...new Set(phones)];
    const [counts, blacklisted] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['shipPhone', 'status'],
        where: { shipPhone: { in: unique } },
        _count: { _all: true },
      }),
      this.prisma.blacklist.findMany({ where: { phone: { in: unique } } }),
    ]);

    const result = new Map<string, CustomerRisk>();
    for (const phone of unique) {
      const mine = counts.filter((c) => c.shipPhone === phone);
      const n = (s: string) =>
        mine.find((c) => c.status === s)?._count._all ?? 0;
      const own = {
        total: mine.reduce((s, c) => s + c._count._all, 0),
        delivered: n('DELIVERED'),
        returned: n('RETURNED'),
        cancelled: n('CANCELLED'),
      };
      const done = own.delivered + own.returned;
      const successRate = done
        ? Math.round((own.delivered / done) * 100)
        : null;
      const black = blacklisted.find((b) => b.phone === phone);

      let level: RiskLevel = 'good';
      if (black) level = 'blacklisted';
      else if (successRate === null) level = 'new';
      else if (successRate < 70 || own.returned >= 2) level = 'risky';

      result.set(phone, {
        level,
        own,
        courier: null,
        successRate,
        blacklistReason: black?.reason,
      });
    }
    return result;
  }
}
