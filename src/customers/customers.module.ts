import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { z } from 'zod';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { AdminOnly } from '../auth/roles.js';
import { adminBdPhone } from '../common/phone.js';
import { Prisma } from '../generated/prisma/client.js';
import { ORDER_INCLUDE, toAdminOrder } from '../orders/order.mapper.js';
import { OrdersModule } from '../orders/orders.module.js';
import { RiskService } from '../orders/risk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SORTS = {
  spent: Prisma.raw('spent DESC'),
  orders: Prisma.raw('orders DESC'),
  recent: Prisma.raw('"lastOrder" DESC'),
  name: Prisma.raw('c.name ASC NULLS LAST'),
} as const;

const listQuery = z.object({
  q: z.string().trim().max(60).optional(),
  tag: z.string().trim().max(30).optional(),
  sort: z.enum(['spent', 'orders', 'recent', 'name']).default('spent'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
});
type ListQuery = z.infer<typeof listQuery>;

const tagsSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(30)).max(20),
});
const noteSchema = z.object({ text: z.string().trim().min(1).max(1000) });

interface CustomerRow {
  id: string;
  phone: string;
  name: string | null;
  tags: string[];
  orders: number;
  spent: number;
  lastOrder: Date;
  district: string | null;
}

/** Customers = phone numbers that ordered. Spent excludes cancelled/returned orders. */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: RiskService,
    private readonly activity: ActivityService,
  ) {}

  async list(q: ListQuery) {
    const filters: Prisma.Sql[] = [];
    if (q.q) {
      const like = `%${q.q.replace(/[%_]/g, '\\$&')}%`;
      const phone = `%${q.q.replace(/[\s-]/g, '').replace(/^\+?880/, '0')}%`;
      filters.push(
        Prisma.sql`(c.phone LIKE ${phone} OR c.name ILIKE ${like} OR EXISTS (
          SELECT 1 FROM orders d WHERE d."customerId" = c.id AND d.district ILIKE ${like}))`,
      );
    }
    if (q.tag) filters.push(Prisma.sql`${q.tag} = ANY(c.tags)`);
    const where = filters.length
      ? Prisma.sql`WHERE ${Prisma.join(filters, ' AND ')}`
      : Prisma.empty;

    const [rows, count] = await Promise.all([
      this.prisma.$queryRaw<CustomerRow[]>`
        SELECT c.id, c.phone, c.name, c.tags,
          COUNT(o.id)::int AS orders,
          COALESCE(SUM(o.total) FILTER (WHERE o.status NOT IN ('CANCELLED', 'RETURNED')), 0)::int AS spent,
          MAX(o."createdAt") AS "lastOrder",
          (ARRAY_AGG(o.district ORDER BY o."createdAt" DESC))[1] AS district
        FROM customers c
        JOIN orders o ON o."customerId" = c.id
        ${where}
        GROUP BY c.id
        ORDER BY ${SORTS[q.sort]}, c.id
        LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      this.prisma.$queryRaw<{ total: number }[]>`
        SELECT COUNT(DISTINCT c.id)::int AS total
        FROM customers c JOIN orders o ON o."customerId" = c.id
        ${where}`,
    ]);
    const total = count[0]?.total ?? 0;
    return {
      data: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        name: r.name ?? '',
        district: r.district ?? '',
        tags: r.tags,
        orders: r.orders,
        spent: r.spent,
        lastOrder: r.lastOrder.toISOString(),
      })),
      meta: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      },
    };
  }

  /** Everything about one number on one page */
  async detail(phone: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { phone },
      include: { notes: { orderBy: { createdAt: 'desc' } } },
    });
    const orders = await this.prisma.order.findMany({
      where: { shipPhone: phone },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    if (!customer && !orders.length)
      throw new NotFoundException('No customer with this number');

    const [risk, blacklist, reviews] = await Promise.all([
      this.risk.forPhones([phone]),
      this.prisma.blacklist.findUnique({ where: { phone } }),
      this.prisma.review.findMany({
        where: { phone },
        select: {
          id: true,
          rating: true,
          text: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const counted = orders.filter(
      (o) => o.status !== 'CANCELLED' && o.status !== 'RETURNED',
    );
    const spent = counted.reduce((s, o) => s + o.total, 0);
    const products = new Map<string, { name: string; qty: number }>();
    for (const o of counted)
      for (const i of o.items) {
        const key = i.productId ?? i.name;
        const p = products.get(key) ?? { name: i.name, qty: 0 };
        p.qty += i.quantity;
        products.set(key, p);
      }
    const by = (s: string) => orders.filter((o) => o.status === s).length;

    return {
      phone,
      name: customer?.name ?? orders[0]?.shipName ?? '',
      email: customer?.email ?? undefined,
      tags: customer?.tags ?? [],
      notes: (customer?.notes ?? []).map((n) => ({
        id: n.id,
        text: n.text,
        by: n.authorName,
        at: n.createdAt.toISOString(),
      })),
      stats: {
        orders: orders.length,
        delivered: by('DELIVERED'),
        returned: by('RETURNED'),
        cancelled: by('CANCELLED'),
        spent,
        averageOrder: counted.length ? Math.round(spent / counted.length) : 0,
        firstOrder: orders.at(-1)?.createdAt.toISOString(),
        lastOrder: orders[0]?.createdAt.toISOString(),
      },
      risk: risk.get(phone)!,
      blacklist: blacklist
        ? { reason: blacklist.reason, at: blacklist.createdAt.toISOString() }
        : null,
      addresses: [
        ...new Set(
          orders.map((o) => `${o.address}, ${o.upazila}, ${o.district}`),
        ),
      ],
      bought: [...products.values()].sort((a, b) => b.qty - a.qty),
      orders: orders.map(toAdminOrder),
      reviews: reviews.map((r) => ({
        ...r,
        status: r.status.toLowerCase(),
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  async setTags(me: AdminPrincipal, phone: string, tags: string[]) {
    const unique = [...new Set(tags)];
    const customer = await this.ensure(phone);
    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { tags: unique },
    });
    return { tags: unique };
  }

  async addNote(me: AdminPrincipal, phone: string, text: string) {
    const customer = await this.ensure(phone);
    const note = await this.prisma.customerNote.create({
      data: { customerId: customer.id, text, authorName: me.name },
    });
    await this.activity.log(
      me,
      'customer.note',
      `Note added for ${phone}`,
      `/admin/customers/${phone}`,
    );
    return {
      id: note.id,
      text: note.text,
      by: note.authorName,
      at: note.createdAt.toISOString(),
    };
  }

  async removeNote(phone: string, noteId: string) {
    const { count } = await this.prisma.customerNote.deleteMany({
      where: { id: noteId, customer: { phone } },
    });
    if (!count) throw new NotFoundException('Note not found');
  }

  /** Customers who only ever ordered before the customers table existed get a row on first touch */
  private async ensure(phone: string) {
    const existing = await this.prisma.customer.findUnique({
      where: { phone },
    });
    if (existing) return existing;
    const order = await this.prisma.order.findFirst({
      where: { shipPhone: phone },
      orderBy: { createdAt: 'desc' },
    });
    if (!order) throw new NotFoundException('No customer with this number');
    return this.prisma.customer.create({
      data: { phone, name: order.shipName },
    });
  }
}

@Controller('admin/customers')
@AdminOnly()
export class AdminCustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query({ schema: listQuery }) q: ListQuery) {
    return this.customers.list(q);
  }

  @Get(':phone')
  detail(@Param('phone', { schema: adminBdPhone }) phone: string) {
    return this.customers.detail(phone);
  }

  @Put(':phone/tags')
  tags(
    @CurrentUser() me: AdminPrincipal,
    @Param('phone', { schema: adminBdPhone }) phone: string,
    @Body({ schema: tagsSchema }) body: { tags: string[] },
  ) {
    return this.customers.setTags(me, phone, body.tags);
  }

  @Post(':phone/notes')
  note(
    @CurrentUser() me: AdminPrincipal,
    @Param('phone', { schema: adminBdPhone }) phone: string,
    @Body({ schema: noteSchema }) body: { text: string },
  ) {
    return this.customers.addNote(me, phone, body.text);
  }

  @Delete(':phone/notes/:noteId')
  @HttpCode(204)
  removeNote(
    @Param('phone', { schema: adminBdPhone }) phone: string,
    @Param('noteId', { schema: z.string().max(60) }) noteId: string,
  ) {
    return this.customers.removeNote(phone, noteId);
  }
}

@Module({
  imports: [OrdersModule],
  controllers: [AdminCustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
