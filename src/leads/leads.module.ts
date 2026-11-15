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
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { z } from 'zod';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { AdminOnly } from '../auth/roles.js';
import { fromDbEnum } from '../common/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const id = z.string().max(60);
const listQuery = z.object({
  /** active = open + called */
  status: z.enum(['active', 'converted', 'dismissed']).default('active'),
  q: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
type ListQuery = z.infer<typeof listQuery>;

const ACTIVE = ['OPEN', 'CALLED'] as const;

type LeadRow = Prisma.IncompleteOrderGetPayload<{ include: { notes: true } }>;

const toApiLead = (r: LeadRow) => ({
  id: r.id,
  phone: r.phone,
  fullName: r.fullName ?? '',
  division: r.division ?? '',
  district: r.district ?? '',
  upazila: r.upazila ?? '',
  address: r.address ?? '',
  items: r.items,
  subtotal: r.subtotal,
  status: fromDbEnum(r.status),
  orderId: r.orderId ?? undefined,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  callNotes: r.notes.map((n) => ({
    at: n.createdAt.toISOString(),
    note: n.note,
    by: n.actorName ?? undefined,
  })),
});

/** Incomplete checkouts: customers who typed their number but did not order */
@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async list(q: ListQuery) {
    const where: Prisma.IncompleteOrderWhereInput =
      q.status === 'active'
        ? { status: { in: [...ACTIVE] } }
        : { status: q.status === 'converted' ? 'CONVERTED' : 'DISMISSED' };
    if (q.q) {
      where.OR = [
        { phone: { contains: q.q.replace(/[\s-]/g, '') } },
        { fullName: { contains: q.q, mode: 'insensitive' } },
      ];
    }
    const [rows, total, active] = await Promise.all([
      this.prisma.incompleteOrder.findMany({
        where,
        include: { notes: { orderBy: { createdAt: 'asc' } } },
        orderBy: { updatedAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.incompleteOrder.count({ where }),
      this.prisma.incompleteOrder.aggregate({
        where: { status: { in: [...ACTIVE] } },
        _count: { _all: true },
        _sum: { subtotal: true },
      }),
    ]);
    return {
      data: rows.map(toApiLead),
      summary: {
        waiting: active._count._all,
        value: active._sum.subtotal ?? 0,
      },
      meta: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      },
    };
  }

  async getOne(leadId: string) {
    const lead = await this.prisma.incompleteOrder.findUnique({
      where: { id: leadId },
      include: { notes: { orderBy: { createdAt: 'asc' } } },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return toApiLead(lead);
  }

  async addNote(me: AdminPrincipal, leadId: string, note: string) {
    const lead = await this.get(leadId);
    await this.prisma.$transaction([
      this.prisma.leadNote.create({
        data: { leadId, note, actorName: me.name },
      }),
      this.prisma.incompleteOrder.update({
        where: { id: leadId },
        data: { status: lead.status === 'OPEN' ? 'CALLED' : undefined },
      }),
    ]);
    return { ok: true };
  }

  async setStatus(
    me: AdminPrincipal,
    leadId: string,
    status: 'open' | 'dismissed',
  ) {
    const lead = await this.get(leadId);
    if (lead.status === 'CONVERTED') {
      throw new NotFoundException('This lead is already an order');
    }
    await this.prisma.incompleteOrder.update({
      where: { id: leadId },
      data: { status: status === 'open' ? 'OPEN' : 'DISMISSED' },
    });
    await this.activity.log(
      me,
      'order.lead',
      `Lead ${lead.phone} → ${status}`,
      '/admin/incomplete',
    );
    return { ok: true };
  }

  async remove(leadId: string) {
    await this.get(leadId);
    await this.prisma.incompleteOrder.delete({ where: { id: leadId } });
  }

  private async get(leadId: string) {
    const lead = await this.prisma.incompleteOrder.findUnique({
      where: { id: leadId },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }
}

@Controller('admin/incomplete-orders')
@AdminOnly()
export class AdminLeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get()
  list(@Query({ schema: listQuery }) q: ListQuery) {
    return this.leads.list(q);
  }

  @Get(':id')
  one(@Param('id', { schema: id }) leadId: string) {
    return this.leads.getOne(leadId);
  }

  @Post(':id/notes')
  @HttpCode(200)
  note(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: id }) leadId: string,
    @Body({ schema: z.object({ note: z.string().trim().min(1).max(300) }) })
    body: { note: string },
  ) {
    return this.leads.addNote(me, leadId, body.note);
  }

  @Patch(':id/status')
  status(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: id }) leadId: string,
    @Body({ schema: z.object({ status: z.enum(['open', 'dismissed']) }) })
    body: { status: 'open' | 'dismissed' },
  ) {
    return this.leads.setStatus(me, leadId, body.status);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', { schema: id }) leadId: string) {
    return this.leads.remove(leadId);
  }
}

@Module({ controllers: [AdminLeadsController], providers: [LeadsService] })
export class LeadsModule {}
