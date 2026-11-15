import { Injectable } from '@nestjs/common';

import {
  type CouponCheckResult,
  CouponsService,
} from '../catalog/coupons.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { StoreSettings } from '../settings/settings.defaults.js';
import { SettingsService } from '../settings/settings.service.js';
import type { CartLine } from './orders.schemas.js';

export interface PricedLine {
  productId: string;
  variantId: string | null;
  name: string;
  slug: string;
  image: string | null;
  color: string | null;
  size: string | null;
  price: number;
  quantity: number;
  costPrice: number | null;
  /** Units available right now */
  available: number;
}

export interface LineProblem {
  productId: string;
  variantId: string | null;
  name?: string;
  reason: 'not-found' | 'unavailable' | 'variant-required' | 'out-of-stock';
  available?: number;
  message: string;
}

/** Inside Dhaka district = inside rate; free above the minimum */
export function deliveryChargeFor(
  settings: StoreSettings,
  district: string | null | undefined,
  subtotal: number,
) {
  const { insideDhaka, outsideDhaka, freeDeliveryMinimum } = settings.delivery;
  if (freeDeliveryMinimum > 0 && subtotal >= freeDeliveryMinimum) return 0;
  return district === 'Dhaka' ? insideDhaka : outsideDhaka;
}

/** The delivery charge paid in advance on COD orders, when the shop asks for it */
export function advanceRequiredFor(
  settings: StoreSettings,
  /** "cod" / "COD" etc. */
  paymentMethod: string,
  district: string | null | undefined,
  deliveryCharge: number,
) {
  const mode = settings.advance.mode;
  const required =
    paymentMethod.toUpperCase() === 'COD' &&
    Boolean(district) &&
    deliveryCharge > 0 &&
    (mode === 'delivery-charge' ||
      (mode === 'outside-dhaka' && district !== 'Dhaka'));
  return required ? deliveryCharge : 0;
}

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly coupons: CouponsService,
  ) {}

  /**
   * Prices cart lines from the database. Shop carts may only contain active or
   * hidden products; admins may also sell drafts and override prices.
   */
  async priceLines(
    lines: (CartLine & { price?: number | null })[],
    opts: { admin?: boolean } = {},
  ) {
    const products = await this.prisma.product.findMany({
      where: { id: { in: [...new Set(lines.map((l) => l.productId))] } },
      include: {
        variants: true,
        images: { orderBy: { sortOrder: 'asc' }, take: 1 },
      },
    });
    const items: PricedLine[] = [];
    const problems: LineProblem[] = [];

    for (const line of lines) {
      const p = products.find((x) => x.id === line.productId);
      const base = {
        productId: line.productId,
        variantId: line.variantId ?? null,
      };
      if (!p || (!opts.admin && p.status === 'DRAFT')) {
        problems.push({
          ...base,
          reason: 'not-found',
          message: 'This product is no longer available',
        });
        continue;
      }
      let variant: (typeof p.variants)[number] | undefined;
      if (p.variants.length) {
        variant = p.variants.find((v) => v.id === line.variantId);
        if (!variant) {
          problems.push({
            ...base,
            name: p.name,
            reason: 'variant-required',
            message: `${p.name}: please select a color/size`,
          });
          continue;
        }
      }
      const available = variant ? variant.stock : p.stock;
      const price =
        opts.admin && line.price != null
          ? line.price
          : (variant?.price ?? p.price);
      items.push({
        ...base,
        variantId: variant?.id ?? null,
        name: p.name,
        slug: p.slug,
        image: p.images[0]?.url ?? null,
        color: variant?.color ?? null,
        size: variant?.size ?? null,
        price,
        quantity: line.quantity,
        costPrice: p.costPrice,
        available,
      });
      if (available < line.quantity) {
        problems.push({
          ...base,
          name: p.name,
          reason: 'out-of-stock',
          available,
          message:
            available > 0
              ? `${p.name}: only ${available} left in stock`
              : `${p.name}: out of stock`,
        });
      }
    }
    return { items, problems };
  }

  /** Cart / checkout totals, computed the same way the order will be */
  async quote(input: {
    items: CartLine[];
    couponCode?: string | null;
    district?: string | null;
    paymentMethod?: string;
  }) {
    const settings = await this.settings.get();
    const { items, problems } = await this.priceLines(input.items);
    const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);

    let coupon: CouponCheckResult | null = null;
    if (input.couponCode)
      coupon = await this.coupons.check(input.couponCode, subtotal);
    const valid = coupon?.ok ? coupon : null;

    const discount = Math.min(valid?.discount ?? 0, subtotal);
    const deliveryKnown = Boolean(input.district);
    const deliveryCharge =
      !deliveryKnown || valid?.freeShipping
        ? 0
        : deliveryChargeFor(settings, input.district, subtotal);
    const total = Math.max(0, subtotal - discount + deliveryCharge);

    return {
      items: items.map(({ costPrice: _admin, ...i }) => i),
      problems,
      subtotal,
      discount,
      deliveryCharge,
      deliveryKnown,
      total,
      coupon,
      advanceAmount: advanceRequiredFor(
        settings,
        input.paymentMethod ?? 'cod',
        input.district,
        deliveryCharge,
      ),
    };
  }
}
