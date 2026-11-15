import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { z } from 'zod';

import { AdminOnly, ROLE_GROUPS } from '../auth/roles.js';
import {
  bdDay,
  bdDayStart,
  bdMonthStart,
  bdRange,
  dateRangeQuery,
  lastBdDays,
} from '../common/dates.js';
import { fromDbEnum } from '../common/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { LOW_STOCK } from '../catalog/products.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

type OrderLite = Prisma.OrderGetPayload<{ include: { items: true } }>;

/** Orders that count as sales on the dashboard (not cancelled/returned) */
const counts = (status: string) =>
  status !== 'CANCELLED' && status !== 'RETURNED';

/** Unknown cost price → assume 60% of the selling price (shown as estimated) */
const lineCost = (i: {
  costPrice: number | null;
  price: number;
  quantity: number;
}) => (i.costPrice ?? Math.round(i.price * 0.6)) * i.quantity;

/** COD the courier collects for a delivered parcel */
const codCollected = (o: OrderLite) =>
  o.paymentMethod === 'COD' ? Math.max(0, o.total - (o.advanceAmount ?? 0)) : 0;

const breakdownQuery = dateRangeQuery.and(
  z.object({
    by: z
      .enum(['product', 'category', 'district', 'source'])
      .default('product'),
  }),
);
const activityQuery = z.object({
  /** e.g. "order", "product", "stock" — the part before the dot */
  group: z.string().trim().max(30).optional(),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private range(q: { from?: string; to?: string }) {
    if (!q.from && !q.to) return undefined;
    return bdRange(q.from ?? '2000-01-01', q.to ?? bdDay(new Date()));
  }

  async dashboard(now = new Date()) {
    const days = lastBdDays(14, now);
    const today = days.at(-1)!;
    const monthStart = bdMonthStart(now);
    const since = bdDayStart(days[0] < monthStart ? days[0] : monthStart);

    const [
      recentOrders,
      pending,
      customers,
      lowStock,
      latest,
      leads,
      reviews,
      byStatus,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where: { createdAt: { gte: since } },
        select: { createdAt: true, total: true, status: true },
      }),
      this.prisma.order.count({ where: { status: 'PENDING' } }),
      this.prisma.customer.count({ where: { orders: { some: {} } } }),
      this.prisma.product.findMany({
        where: { stock: { lte: LOW_STOCK }, status: { not: 'DRAFT' } },
        select: {
          id: true,
          name: true,
          stock: true,
          images: { take: 1, select: { url: true } },
        },
        orderBy: { stock: 'asc' },
        take: 6,
      }),
      this.prisma.order.findMany({
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: {
          id: true,
          orderNumber: true,
          shipName: true,
          total: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.incompleteOrder.count({ where: { status: 'OPEN' } }),
      this.prisma.review.count({ where: { status: 'PENDING' } }),
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);

    const series = new Map(days.map((d) => [d, { revenue: 0, orders: 0 }]));
    let todayRevenue = 0;
    let todayOrders = 0;
    let monthRevenue = 0;
    for (const o of recentOrders) {
      const d = bdDay(o.createdAt);
      const point = series.get(d);
      if (point) {
        point.orders += 1;
        if (counts(o.status)) point.revenue += o.total;
      }
      if (d === today) {
        todayOrders += 1;
        if (counts(o.status)) todayRevenue += o.total;
      }
      if (d >= monthStart && counts(o.status)) monthRevenue += o.total;
    }

    return {
      todayRevenue,
      todayOrders,
      pending,
      monthRevenue,
      customers,
      incompleteOrders: leads,
      pendingReviews: reviews,
      revenueSeries: days.map((date) => ({ date, ...series.get(date)! })),
      statusBreakdown: Object.fromEntries(
        byStatus.map((s) => [fromDbEnum(s.status), s._count._all]),
      ),
      lowStock: lowStock.map(({ images, ...p }) => ({
        ...p,
        image: images[0]?.url,
      })),
      recentOrders: latest.map((o) => ({
        ...o,
        status: fromDbEnum(o.status),
        createdAt: o.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Profit & loss on a delivered basis (an order counts when the customer has
   * it). Returned parcels still cost the courier charge.
   */
  async profitLoss(q: { from?: string; to?: string }) {
    const createdAt = this.range(q);
    const [orders, expenses] = await Promise.all([
      this.prisma.order.findMany({
        where: { createdAt },
        include: { items: true },
      }),
      this.prisma.expense.findMany({
        where: createdAt
          ? {
              date: {
                gte: new Date(`${q.from ?? '2000-01-01'}T00:00:00Z`),
                lte: new Date(`${q.to ?? bdDay(new Date())}T23:59:59Z`),
              },
            }
          : {},
      }),
    ]);
    const delivered = orders.filter((o) => o.status === 'DELIVERED');
    const returned = orders.filter((o) => o.status === 'RETURNED');
    const pipeline = orders.filter((o) =>
      ['CONFIRMED', 'PROCESSING', 'SHIPPED'].includes(o.status),
    );

    const revenue = delivered.reduce((s, o) => s + o.total, 0);
    const productCost = delivered.reduce(
      (s, o) => s + o.items.reduce((n, i) => n + lineCost(i), 0),
      0,
    );
    const estimatedCost = delivered.some((o) =>
      o.items.some((i) => i.costPrice == null),
    );
    const courierCost = [...delivered, ...returned].reduce(
      (s, o) => s + (o.courierCharge ?? 0),
      0,
    );
    const refunds = orders.reduce((s, o) => s + (o.refundAmount ?? 0), 0);
    const grossProfit = revenue - productCost - courierCost;

    const expenseByCategory: Record<string, number> = {};
    for (const e of expenses) {
      expenseByCategory[e.category] =
        (expenseByCategory[e.category] ?? 0) + e.amount;
    }
    const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
    const netProfit = grossProfit - totalExpenses - refunds;

    return {
      orders: orders.length,
      delivered: delivered.length,
      returned: returned.length,
      cancelled: orders.filter((o) => o.status === 'CANCELLED').length,
      inPipeline: pipeline.length,
      pipelineValue: pipeline.reduce((s, o) => s + o.total, 0),
      returnRate:
        delivered.length + returned.length
          ? Math.round(
              (returned.length / (delivered.length + returned.length)) * 100,
            )
          : 0,
      revenue,
      productCost,
      estimatedCost,
      courierCost,
      grossProfit,
      refunds,
      expenses: totalExpenses,
      expenseByCategory,
      netProfit,
      margin: revenue ? Math.round((netProfit / revenue) * 100) : 0,
    };
  }

  /** Delivered sales grouped by product / category / district / source */
  async breakdown(q: z.infer<typeof breakdownQuery>) {
    const orders = await this.prisma.order.findMany({
      where: { status: 'DELIVERED', createdAt: this.range(q) },
      include: { items: true },
    });
    const categoryOf = new Map<string, string>();
    if (q.by === 'category') {
      const ids = [
        ...new Set(
          orders
            .flatMap((o) => o.items.map((i) => i.productId))
            .filter(Boolean),
        ),
      ];
      const products = await this.prisma.product.findMany({
        where: { id: { in: ids as string[] } },
        select: {
          id: true,
          category: {
            select: { name: true, parent: { select: { name: true } } },
          },
        },
      });
      for (const p of products) {
        categoryOf.set(p.id, p.category.parent?.name ?? p.category.name);
      }
    }

    const rows = new Map<
      string,
      {
        key: string;
        label: string;
        orders: Set<string>;
        qty: number;
        revenue: number;
        profit: number;
      }
    >();
    const bump = (
      key: string,
      label: string,
      orderId: string,
      qty: number,
      revenue: number,
      cost: number,
    ) => {
      const r = rows.get(key) ?? {
        key,
        label,
        orders: new Set(),
        qty: 0,
        revenue: 0,
        profit: 0,
      };
      r.orders.add(orderId);
      r.qty += qty;
      r.revenue += revenue;
      r.profit += revenue - cost;
      rows.set(key, r);
    };
    for (const o of orders) {
      if (q.by === 'district' || q.by === 'source') {
        const key = q.by === 'district' ? o.district : fromDbEnum(o.source);
        bump(
          key,
          key,
          o.id,
          o.items.reduce((n, i) => n + i.quantity, 0),
          o.subtotal - o.discount,
          o.items.reduce((n, i) => n + lineCost(i), 0),
        );
        continue;
      }
      for (const i of o.items) {
        const key =
          q.by === 'product'
            ? (i.productId ?? i.name)
            : (categoryOf.get(i.productId ?? '') ?? 'Deleted products');
        bump(
          key,
          q.by === 'product' ? i.name : key,
          o.id,
          i.quantity,
          i.price * i.quantity,
          lineCost(i),
        );
      }
    }
    return [...rows.values()]
      .map(({ orders: o, ...r }) => ({ ...r, orders: o.size }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  /** What the couriers owe the shop (COD collected minus their charge) */
  async courier() {
    const orders = await this.prisma.order.findMany({
      where: {
        courierName: { not: null },
        status: { in: ['SHIPPED', 'DELIVERED', 'RETURNED'] },
      },
      include: { items: true },
    });
    const byCourier = new Map<
      string,
      {
        courier: string;
        due: number;
        dueParcels: number;
        inTransit: number;
        inTransitParcels: number;
        returned: number;
      }
    >();
    for (const o of orders) {
      const name = o.courierName!;
      const row = byCourier.get(name) ?? {
        courier: name,
        due: 0,
        dueParcels: 0,
        inTransit: 0,
        inTransitParcels: 0,
        returned: 0,
      };
      if (o.status === 'SHIPPED') {
        row.inTransit += codCollected(o);
        row.inTransitParcels += 1;
      } else if (!o.codSettled) {
        if (o.status === 'DELIVERED') {
          row.due += codCollected(o) - (o.courierCharge ?? 0);
          row.dueParcels += 1;
        } else {
          row.due -= o.courierCharge ?? 0;
          row.returned += 1;
        }
      }
      byCourier.set(name, row);
    }
    const list = [...byCourier.values()];
    return {
      totalDue: list.reduce((s, r) => s + r.due, 0),
      inTransit: list.reduce((s, r) => s + r.inTransit, 0),
      byCourier: list,
    };
  }

  async activity(q: z.infer<typeof activityQuery>) {
    const where: Prisma.ActivityLogWhereInput = {};
    if (q.group) where.action = { startsWith: `${q.group}.` };
    if (q.q) {
      where.OR = [
        { message: { contains: q.q, mode: 'insensitive' } },
        { actorName: { contains: q.q, mode: 'insensitive' } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.activityLog.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        actor: r.actorName,
        action: r.action,
        message: r.message,
        href: r.href ?? undefined,
      })),
      meta: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      },
    };
  }
}

@Controller('admin')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Everyone sees the dashboard */
  @AdminOnly()
  @Get('dashboard')
  dashboard() {
    return this.reports.dashboard();
  }

  @AdminOnly(...ROLE_GROUPS.manager)
  @Get('reports/profit-loss')
  profitLoss(
    @Query({ schema: dateRangeQuery }) q: { from?: string; to?: string },
  ) {
    return this.reports.profitLoss(q);
  }

  @AdminOnly(...ROLE_GROUPS.manager)
  @Get('reports/breakdown')
  breakdown(
    @Query({ schema: breakdownQuery }) q: z.infer<typeof breakdownQuery>,
  ) {
    return this.reports.breakdown(q);
  }

  @AdminOnly(...ROLE_GROUPS.manager)
  @Get('reports/courier')
  courier() {
    return this.reports.courier();
  }

  @AdminOnly(...ROLE_GROUPS.manager)
  @Get('activity')
  activity(@Query({ schema: activityQuery }) q: z.infer<typeof activityQuery>) {
    return this.reports.activity(q);
  }
}

@Module({ controllers: [AdminReportsController], providers: [ReportsService] })
export class ReportsModule {}
