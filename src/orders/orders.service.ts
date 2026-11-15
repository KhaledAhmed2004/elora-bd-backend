import { randomInt } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { type ApiOrderStatus, fromDbEnum, toDbEnum } from '../common/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  CallResult,
  OrderSource,
  OrderStatus,
  PaymentMethod,
} from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  ORDER_INCLUDE,
  type OrderRow,
  toAdminOrder,
  toCustomerOrder,
} from './order.mapper.js';
import type {
  AdminOrderInput,
  AdminOrderQuery,
  CallInput,
  PlaceOrderInput,
  ReturnInput,
} from './orders.schemas.js';
import {
  advanceRequiredFor,
  deliveryChargeFor,
  type PricedLine,
  PricingService,
} from './pricing.service.js';
import { RiskService } from './risk.service.js';
import { adjustSold, deductStock, restock, type StockLine } from './stock.js';

type Tx = Prisma.TransactionClient;

/** Statuses where the goods are out of (or reserved from) stock */
const HOLDS_STOCK: OrderStatus[] = [
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
];

/** Allowed moves. Delivered/returned orders can't go back to "in progress". */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'CANCELLED'],
  CONFIRMED: ['PENDING', 'PROCESSING', 'SHIPPED', 'CANCELLED'],
  PROCESSING: ['CONFIRMED', 'SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED', 'RETURNED', 'CANCELLED'],
  DELIVERED: ['RETURNED'],
  CANCELLED: ['PENDING', 'CONFIRMED'],
  RETURNED: [],
};

/** Items can be changed until the parcel leaves */
const EDITABLE: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PROCESSING'];

const COURIER_PREFIX: Record<string, string> = {
  Steadfast: 'SF',
  Pathao: 'PT',
  RedX: 'RX',
};

const stockLines = (items: OrderRow['items']): StockLine[] =>
  items.map((i) => ({
    productId: i.productId,
    variantId: i.variantId,
    name: i.name,
    quantity: i.quantity,
  }));

const itemRows = (items: PricedLine[]) =>
  items.map((i) => ({
    productId: i.productId,
    variantId: i.variantId,
    name: i.name,
    image: i.image,
    color: i.color,
    size: i.size,
    price: i.price,
    quantity: i.quantity,
    costPrice: i.costPrice,
  }));

const orderHref = (id: string) => `/admin/orders/${id}`;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
    private readonly settings: SettingsService,
    private readonly risk: RiskService,
    private readonly activity: ActivityService,
  ) {}

  // ───────────────────────── Shop ─────────────────────────

  /**
   * Website checkout. Everything is recomputed here: prices, stock, coupon,
   * delivery charge and the advance rule. The browser's numbers are ignored.
   */
  async place(input: PlaceOrderInput) {
    const a = input.shippingAddress;
    const blocked = await this.prisma.blacklist.findUnique({
      where: { phone: a.phone },
    });
    if (blocked) {
      throw new ForbiddenException(
        "We can't accept online orders from this number. Please call us to place an order.",
      );
    }

    const settings = await this.settings.get();
    if (!settings.payments[input.paymentMethod]) {
      throw new BadRequestException('This payment method is currently unavailable');
    }

    const { items, problems } = await this.pricing.priceLines(input.items);
    if (problems.length) {
      throw new ConflictException({
        message: problems.map((p) => p.message).join(' · '),
        problems,
      });
    }

    const quote = await this.pricing.quote({
      items: input.items,
      couponCode: input.couponCode,
      district: a.district,
      paymentMethod: input.paymentMethod,
    });
    if (input.couponCode && quote.coupon && !quote.coupon.ok) {
      throw new BadRequestException(quote.coupon.error);
    }
    const coupon = quote.coupon?.ok ? quote.coupon : null;

    const advanceAmount = advanceRequiredFor(
      settings,
      input.paymentMethod,
      a.district,
      quote.deliveryCharge,
    );
    if (advanceAmount && !input.advance?.trxId) {
      throw new BadRequestException(
        `Please pay the ৳${advanceAmount} delivery charge in advance and enter the transaction ID`,
      );
    }

    const order = await this.withOrderNumber((orderNumber) =>
      this.prisma.$transaction(async (tx) => {
        if (coupon) await this.useCoupon(tx, coupon.code);
        const customer = await tx.customer.upsert({
          where: { phone: a.phone },
          create: {
            phone: a.phone,
            name: a.fullName,
            email: input.email || null,
          },
          update: {},
          select: { id: true, name: true },
        });
        if (!customer.name) {
          await tx.customer.update({
            where: { id: customer.id },
            data: { name: a.fullName },
          });
        }
        const created = await tx.order.create({
          data: {
            orderNumber,
            customerId: customer.id,
            source: 'WEBSITE',
            paymentMethod: toDbEnum<PaymentMethod>(input.paymentMethod),
            shipName: a.fullName,
            shipPhone: a.phone,
            division: a.division,
            district: a.district,
            upazila: a.upazila,
            address: a.address,
            subtotal: quote.subtotal,
            deliveryCharge: quote.deliveryCharge,
            discount: quote.discount,
            total: quote.total,
            couponCode: coupon?.code,
            note: input.note || null,
            ...(advanceAmount && input.advance
              ? {
                  advanceAmount,
                  advanceMethod: toDbEnum<PaymentMethod>(input.advance.method),
                  advanceTrxId: input.advance.trxId,
                  advanceSender: input.advance.senderNumber || null,
                }
              : {}),
            items: { create: itemRows(items) },
            history: {
              create: {
                status: 'PENDING',
                note: 'Order placed on the website',
              },
            },
          },
          include: ORDER_INCLUDE,
        });
        // The checkout lead (incomplete order) for this number is now an order
        await tx.incompleteOrder.updateMany({
          where: { phone: a.phone, status: { in: ['OPEN', 'CALLED'] } },
          data: { status: 'CONVERTED', orderId: created.id },
        });
        return created;
      }),
    );
    return toCustomerOrder(order);
  }

  /** Order number + the phone it was placed with (so numbers can't be enumerated) */
  async track(orderNumber: string, phone: string) {
    const order = await this.prisma.order.findFirst({
      where: { orderNumber, shipPhone: phone },
      include: ORDER_INCLUDE,
    });
    if (!order)
      throw new NotFoundException('No order found for this number');
    return toCustomerOrder(order);
  }

  /** Saves/updates the open checkout lead for this phone */
  async captureLead(input: {
    phone: string;
    fullName?: string | null;
    division?: string | null;
    district?: string | null;
    upazila?: string | null;
    address?: string | null;
    items: PlaceOrderInput['items'];
  }) {
    const { items } = await this.pricing.priceLines(input.items);
    if (!items.length) return { ok: true };
    const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const data = {
      phone: input.phone,
      fullName: input.fullName || null,
      division: input.division || null,
      district: input.district || null,
      upazila: input.upazila || null,
      address: input.address || null,
      subtotal,
      items: items.map(({ costPrice: _c, available: _a, ...i }) => i),
    };
    const open = await this.prisma.incompleteOrder.findFirst({
      where: { phone: input.phone, status: { in: ['OPEN', 'CALLED'] } },
      select: { id: true },
    });
    if (open) {
      await this.prisma.incompleteOrder.update({
        where: { id: open.id },
        data,
      });
    } else {
      await this.prisma.incompleteOrder.create({ data });
    }
    return { ok: true };
  }

  // ───────────────────────── Admin: read ─────────────────────────

  async list(q: AdminOrderQuery) {
    const where: Prisma.OrderWhereInput = {};
    if (q.status) where.status = toDbEnum<OrderStatus>(q.status);
    if (q.source) where.source = toDbEnum<OrderSource>(q.source);
    if (q.phone) where.shipPhone = q.phone;
    if (q.courierSettled) {
      where.courierName = { not: null };
      where.codSettled = q.courierSettled === 'true';
    }
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(`${q.from}T00:00:00+06:00`) } : {}),
        ...(q.to
          ? {
              lt: new Date(
                new Date(`${q.to}T00:00:00+06:00`).getTime() + 86_400_000,
              ),
            }
          : {}),
      };
    }
    if (q.q) {
      const term = q.q.replace(/[\s-]/g, '').replace(/^\+?880/, '0');
      where.OR = [
        { orderNumber: { contains: q.q, mode: 'insensitive' } },
        { shipName: { contains: q.q, mode: 'insensitive' } },
        { shipPhone: { contains: term } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.order.count({ where }),
    ]);
    const risks = await this.risk.forPhones(rows.map((r) => r.shipPhone));
    return {
      data: rows.map((r) => ({
        ...toAdminOrder(r),
        risk: risks.get(r.shipPhone)!,
      })),
      meta: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      },
    };
  }

  /** Numbers for the status tabs */
  async counts() {
    const rows = await this.prisma.order.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const out: Record<string, number> = { all: 0 };
    for (const r of rows) {
      out[fromDbEnum(r.status)] = r._count._all;
      out.all += r._count._all;
    }
    return out;
  }

  async get(id: string) {
    const order = await this.findOrThrow(id);
    const risks = await this.risk.forPhones([order.shipPhone]);
    return { ...toAdminOrder(order), risk: risks.get(order.shipPhone)! };
  }

  // ───────────────────────── Admin: write ─────────────────────────

  /** Manual order (Facebook / WhatsApp / phone) */
  async createManual(me: AdminPrincipal, input: AdminOrderInput) {
    const { items, total, subtotal, deliveryCharge } =
      await this.priceAdminOrder(input);
    const a = input.shippingAddress;
    const order = await this.withOrderNumber((orderNumber) =>
      this.prisma.$transaction(async (tx) => {
        const customer = await tx.customer.upsert({
          where: { phone: a.phone },
          create: { phone: a.phone, name: a.fullName },
          update: {},
          select: { id: true },
        });
        return tx.order.create({
          data: {
            orderNumber,
            customerId: customer.id,
            source: toDbEnum<OrderSource>(input.source),
            paymentMethod: toDbEnum<PaymentMethod>(input.paymentMethod),
            shipName: a.fullName,
            shipPhone: a.phone,
            division: a.division,
            district: a.district,
            upazila: a.upazila,
            address: a.address,
            subtotal,
            deliveryCharge,
            discount: input.discount,
            total,
            note: input.note || null,
            adminNote: input.adminNote || null,
            ...(input.advance
              ? {
                  advanceAmount: input.advance.amount,
                  advanceMethod: toDbEnum<PaymentMethod>(input.advance.method),
                  advanceTrxId: input.advance.trxId,
                  // Entered by staff after checking the bKash/Nagad statement
                  advanceVerified: true,
                }
              : {}),
            items: { create: itemRows(items) },
            history: {
              create: {
                status: 'PENDING',
                note: 'Created by admin',
                actorName: me.name,
              },
            },
          },
          select: { id: true, orderNumber: true },
        });
      }),
    );
    if (input.leadId) {
      await this.prisma.incompleteOrder.updateMany({
        where: { id: input.leadId, status: { in: ['OPEN', 'CALLED'] } },
        data: { status: 'CONVERTED', orderId: order.id },
      });
    }
    await this.activity.log(
      me,
      'order.create',
      `${order.orderNumber}: manual order (${input.source})`,
      orderHref(order.id),
    );
    if (input.status === 'confirmed') {
      await this.changeStatus(me, order.id, 'confirmed', {
        note: 'Confirmed on creation',
      });
    }
    return this.get(order.id);
  }

  /** Items, address and charges. If stock was already taken out, it is re-synced. */
  async edit(me: AdminPrincipal, id: string, input: AdminOrderInput) {
    const old = await this.findOrThrow(id);
    if (!EDITABLE.includes(old.status)) {
      throw new ConflictException(
        'Orders can only be edited before they are shipped',
      );
    }
    const { items, total, subtotal, deliveryCharge } =
      await this.priceAdminOrder(input);
    const a = input.shippingAddress;
    await this.prisma.$transaction(async (tx) => {
      if (old.stockDeducted) {
        await restock(tx, stockLines(old.items));
        await deductStock(tx, items);
      }
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      await tx.order.update({
        where: { id },
        data: {
          paymentMethod: toDbEnum<PaymentMethod>(input.paymentMethod),
          shipName: a.fullName,
          shipPhone: a.phone,
          division: a.division,
          district: a.district,
          upazila: a.upazila,
          address: a.address,
          subtotal,
          deliveryCharge,
          discount: input.discount,
          total,
          note: input.note || null,
          adminNote: input.adminNote || null,
          ...(input.advance
            ? {
                advanceAmount: input.advance.amount,
                advanceMethod: toDbEnum<PaymentMethod>(input.advance.method),
                advanceTrxId: input.advance.trxId,
              }
            : {}),
          items: { create: itemRows(items) },
          history: {
            create: {
              status: old.status,
              note: 'Order edited',
              actorName: me.name,
            },
          },
        },
      });
    });
    await this.activity.log(
      me,
      'order.edit',
      `${old.orderNumber}: order edited`,
      orderHref(id),
    );
    return this.get(id);
  }

  /**
   * Status change with stock kept in sync:
   *  - into confirmed/packing/shipped/delivered: take items out of stock (once)
   *  - into cancelled/returned: put them back (unless restock=false: damaged)
   * Guarded against two staff changing the same order at once.
   */
  async changeStatus(
    me: AdminPrincipal,
    id: string,
    next: ApiOrderStatus,
    opts: { note?: string | null; restock?: boolean } = {},
  ) {
    const order = await this.findOrThrow(id);
    const to = toDbEnum<OrderStatus>(next);
    if (order.status === to) return this.get(id);
    if (!TRANSITIONS[order.status].includes(to)) {
      throw new ConflictException(
        `Cannot move an order from ${fromDbEnum(order.status)} to ${next}`,
      );
    }
    const lines = stockLines(order.items);

    await this.prisma.$transaction(async (tx) => {
      let stockDeducted = order.stockDeducted;
      if (HOLDS_STOCK.includes(to) && !stockDeducted) {
        await deductStock(tx, lines);
        stockDeducted = true;
      } else if ((to === 'CANCELLED' || to === 'RETURNED') && stockDeducted) {
        if (opts.restock !== false) await restock(tx, lines);
        stockDeducted = false;
      }
      if (to === 'DELIVERED') await adjustSold(tx, lines, 1);
      if (order.status === 'DELIVERED' && to === 'RETURNED')
        await adjustSold(tx, lines, -1);

      // Only succeeds if nobody changed the order since we read it
      const { count } = await tx.order.updateMany({
        where: { id, status: order.status, updatedAt: order.updatedAt },
        data: {
          status: to,
          stockDeducted,
          paymentStatus:
            to === 'DELIVERED' && order.paymentMethod === 'COD'
              ? 'PAID'
              : undefined,
          cancelReason:
            to === 'CANCELLED' ? (opts.note ?? 'Cancelled') : undefined,
        },
      });
      if (!count) {
        throw new ConflictException(
          'This order was just changed by someone else. Reload and try again.',
        );
      }
      await tx.orderStatusHistory.create({
        data: {
          orderId: id,
          status: to,
          note: opts.note ?? null,
          actorName: me.name,
        },
      });
    });

    await this.activity.log(
      me,
      'order.status',
      `${order.orderNumber}: ${fromDbEnum(order.status)} → ${next}${opts.note ? ` (${opts.note})` : ''}`,
      orderHref(id),
    );
    return this.get(id);
  }

  async bulkStatus(me: AdminPrincipal, ids: string[], status: ApiOrderStatus) {
    const done: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        await this.changeStatus(me, id, status);
        done.push(id);
      } catch (e) {
        failed.push({ id, error: (e as Error).message });
      }
    }
    return { done, failed };
  }

  /** Confirmation call; "confirmed" / "cancelled" also move a pending order */
  async logCall(me: AdminPrincipal, id: string, input: CallInput) {
    const order = await this.findOrThrow(id);
    await this.prisma.orderCall.create({
      data: {
        orderId: id,
        result: toDbEnum<CallResult>(input.result),
        note: input.note || null,
        actorName: me.name,
      },
    });
    await this.activity.log(
      me,
      'order.call',
      `${order.orderNumber}: call — ${input.result}${input.note ? ` (${input.note})` : ''}`,
      orderHref(id),
    );
    if (input.result === 'confirmed' && order.status === 'PENDING') {
      return this.changeStatus(me, id, 'confirmed', {
        note: 'Confirmed on call',
      });
    }
    if (
      input.result === 'cancelled' &&
      TRANSITIONS[order.status].includes('CANCELLED')
    ) {
      return this.changeStatus(me, id, 'cancelled', {
        note: input.note || 'Cancelled on call',
      });
    }
    return this.get(id);
  }

  async setAdminNote(me: AdminPrincipal, id: string, adminNote: string) {
    await this.findOrThrow(id);
    await this.prisma.order.update({
      where: { id },
      data: { adminNote: adminNote || null },
    });
    return this.get(id);
  }

  async verifyAdvance(me: AdminPrincipal, id: string, verified: boolean) {
    const order = await this.findOrThrow(id);
    if (order.advanceAmount == null)
      throw new BadRequestException('This order has no advance');
    await this.prisma.order.update({
      where: { id },
      data: { advanceVerified: verified },
    });
    await this.activity.log(
      me,
      'order.advance',
      `${order.orderNumber}: advance ${verified ? 'verified' : 'marked unverified'}`,
      orderHref(id),
    );
    return this.get(id);
  }

  /** Parcel came back from the courier */
  async processReturn(me: AdminPrincipal, id: string, input: ReturnInput) {
    const order = await this.findOrThrow(id);
    if (input.refundAmount > order.total) {
      throw new BadRequestException(
        'Refund cannot be more than the order total',
      );
    }
    await this.changeStatus(me, id, 'returned', {
      note: input.reason,
      restock: input.restock,
    });
    if (input.refundAmount > 0) {
      await this.prisma.order.update({
        where: { id },
        data: {
          paymentStatus: 'REFUNDED',
          refundAmount: input.refundAmount,
          refundMethod: input.refundMethod,
          refundedAt: new Date(),
        },
      });
      await this.activity.log(
        me,
        'order.refund',
        `${order.orderNumber}: refunded ৳${input.refundAmount} via ${input.refundMethod}`,
        orderHref(id),
      );
    }
    return this.get(id);
  }

  /**
   * MOCK courier booking: saves a tracking number and marks the order shipped.
   * Step 7 replaces the tracking number with the Steadfast/Pathao/RedX API call.
   */
  async bookCourier(me: AdminPrincipal, ids: string[], courier: string) {
    const settings = await this.settings.get();
    const booked: string[] = [];
    const skipped: { id: string; error: string }[] = [];
    for (const id of ids) {
      const o = await this.prisma.order.findUnique({ where: { id } });
      if (!o) {
        skipped.push({ id, error: 'Not found' });
        continue;
      }
      if (o.courierName || !['CONFIRMED', 'PROCESSING'].includes(o.status)) {
        skipped.push({
          id,
          error: 'Only confirmed/packing orders without a courier',
        });
        continue;
      }
      const trackingId = `${COURIER_PREFIX[courier] ?? 'CR'}${randomInt(1_000_000, 9_999_999)}`;
      await this.prisma.order.update({
        where: { id },
        data: {
          courierName: courier,
          trackingId,
          courierCharge:
            o.district === 'Dhaka'
              ? settings.courierCharge.insideDhaka
              : settings.courierCharge.outsideDhaka,
          codSettled: false,
        },
      });
      try {
        await this.changeStatus(me, id, 'shipped', {
          note: `${courier} tracking: ${trackingId}`,
        });
        booked.push(id);
      } catch (e) {
        skipped.push({ id, error: (e as Error).message });
      }
    }
    return { booked, skipped };
  }

  /** COD money received from the courier (or undo) */
  async settle(me: AdminPrincipal, ids: string[], settled: boolean) {
    const { count } = await this.prisma.order.updateMany({
      where: { id: { in: ids }, courierName: { not: null } },
      data: { codSettled: settled, settledAt: settled ? new Date() : null },
    });
    if (count) {
      await this.activity.log(
        me,
        'order.settlement',
        `${count} parcel(s) marked COD ${settled ? 'received' : 'not received'}`,
      );
    }
    return { updated: count };
  }

  // ───────────────────────── helpers ─────────────────────────

  private async findOrThrow(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  private async priceAdminOrder(input: AdminOrderInput) {
    const { items, problems } = await this.pricing.priceLines(input.items, {
      admin: true,
    });
    const blocking = problems.filter((p) => p.reason !== 'out-of-stock');
    if (blocking.length) {
      throw new BadRequestException(blocking.map((p) => p.message).join(' · '));
    }
    const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    if (input.discount > subtotal) {
      throw new BadRequestException(
        'Discount cannot be more than the subtotal',
      );
    }
    const settings = await this.settings.get();
    const deliveryCharge =
      input.deliveryCharge ??
      deliveryChargeFor(settings, input.shippingAddress.district, subtotal);
    return {
      items,
      subtotal,
      deliveryCharge,
      total: Math.max(0, subtotal - input.discount + deliveryCharge),
    };
  }

  /** Counts a coupon use; fails if its usage limit was reached meanwhile */
  private async useCoupon(tx: Tx, code: string) {
    const coupon = await tx.coupon.findUnique({ where: { code } });
    if (!coupon) throw new BadRequestException('This coupon code is not valid');
    const { count } = await tx.coupon.updateMany({
      where: {
        code,
        active: true,
        ...(coupon.usageLimit != null
          ? { usedCount: { lt: coupon.usageLimit } }
          : {}),
      },
      data: { usedCount: { increment: 1 } },
    });
    if (!count)
      throw new ConflictException('This coupon has reached its usage limit');
  }

  /** "BD-123456"; retries on the rare collision with an existing number */
  private async withOrderNumber<T>(
    create: (orderNumber: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNumber = `BD-${randomInt(100_000, 1_000_000)}`;
      try {
        return await create(orderNumber);
      } catch (e) {
        const clash =
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          `${JSON.stringify(e.meta ?? {})} ${e.message}`.includes(
            'orderNumber',
          );
        if (!clash) throw e;
      }
    }
    throw new ConflictException('Could not create an order number, try again');
  }
}
