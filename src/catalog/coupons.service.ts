import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import type { Coupon } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CouponInput } from './catalog.schemas.js';

export type CouponCheckResult =
  | {
      ok: true;
      code: string;
      description: string;
      type: Coupon['type'];
      /** Taka off the subtotal (0 for free shipping) */
      discount: number;
      freeShipping: boolean;
    }
  | { ok: false; error: string };

/** Discount for a subtotal — the same rules the checkout uses */
export function couponDiscount(coupon: Coupon, subtotal: number) {
  if (coupon.type === 'PERCENT') {
    const d = Math.round((subtotal * coupon.value) / 100);
    return coupon.maxDiscount ? Math.min(d, coupon.maxDiscount) : d;
  }
  if (coupon.type === 'FIXED') return Math.min(coupon.value, subtotal);
  return 0;
}

@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  /** Customer-facing check (messages shown in the shop) */
  async check(code: string, subtotal: number): Promise<CouponCheckResult> {
    const coupon = await this.prisma.coupon.findUnique({
      where: { code: code.trim().toUpperCase() },
    });
    if (!coupon || !coupon.active) {
      return { ok: false, error: 'This coupon code is not valid' };
    }
    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      return { ok: false, error: 'This coupon has expired' };
    }
    if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
      return { ok: false, error: 'This coupon has reached its usage limit' };
    }
    if (coupon.minSubtotal && subtotal < coupon.minSubtotal) {
      return {
        ok: false,
        error: `This coupon needs a minimum order of ৳${coupon.minSubtotal.toLocaleString('en-IN')}`,
      };
    }
    return {
      ok: true,
      code: coupon.code,
      description: coupon.description,
      type: coupon.type,
      discount: couponDiscount(coupon, subtotal),
      freeShipping: coupon.type === 'FREE_SHIPPING',
    };
  }

  list() {
    return this.prisma.coupon.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(me: AdminPrincipal, dto: CouponInput) {
    const exists = await this.prisma.coupon.findUnique({
      where: { code: dto.code },
    });
    if (exists) throw new ConflictException('This coupon code already exists');
    const created = await this.prisma.coupon.create({ data: toData(dto) });
    await this.activity.log(me, 'catalog.coupon', `Created coupon ${dto.code}`);
    return created;
  }

  async update(me: AdminPrincipal, code: string, dto: CouponInput) {
    await this.get(code);
    if (dto.code !== code) {
      throw new ConflictException(
        'The code cannot be changed; create a new coupon',
      );
    }
    const updated = await this.prisma.coupon.update({
      where: { code },
      data: toData(dto),
    });
    await this.activity.log(me, 'catalog.coupon', `Updated coupon ${code}`);
    return updated;
  }

  async remove(me: AdminPrincipal, code: string) {
    await this.get(code);
    await this.prisma.coupon.delete({ where: { code } });
    await this.activity.log(me, 'catalog.coupon', `Deleted coupon ${code}`);
  }

  private async get(code: string) {
    const c = await this.prisma.coupon.findUnique({ where: { code } });
    if (!c) throw new NotFoundException('Coupon not found');
    return c;
  }
}

const toData = (dto: CouponInput) => ({
  code: dto.code,
  description: dto.description,
  type: dto.type,
  value: dto.type === 'FREE_SHIPPING' ? 0 : dto.value,
  minSubtotal: dto.minSubtotal ?? null,
  maxDiscount: dto.type === 'PERCENT' ? (dto.maxDiscount ?? null) : null,
  usageLimit: dto.usageLimit ?? null,
  active: dto.active,
  expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
});
