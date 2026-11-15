import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { AdminOnly, ROLE_GROUPS } from '../auth/roles.js';
import type { ApiOrderStatus } from '../common/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  adminNoteSchema,
  type AdminOrderInput,
  type AdminOrderQuery,
  adminOrderQuerySchema,
  adminOrderSchema,
  blacklistSchema,
  bulkStatusSchema,
  type CallInput,
  callSchema,
  courierBookSchema,
  idParam,
  phoneParam,
  type ReturnInput,
  returnSchema,
  settleSchema,
  type StatusChangeInput,
  statusChangeSchema,
  verifyAdvanceSchema,
} from './orders.schemas.js';
import { OrdersService } from './orders.service.js';

/** Every staff member works orders and calls */
@Controller('admin/orders')
@AdminOnly()
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list(@Query({ schema: adminOrderQuerySchema }) query: AdminOrderQuery) {
    return this.orders.list(query);
  }

  @Get('counts')
  counts() {
    return this.orders.counts();
  }

  @Get(':id')
  get(@Param('id', { schema: idParam }) id: string) {
    return this.orders.get(id);
  }

  @Post()
  create(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: adminOrderSchema }) body: AdminOrderInput,
  ) {
    return this.orders.createManual(me, body);
  }

  @Put(':id')
  edit(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: adminOrderSchema }) body: AdminOrderInput,
  ) {
    return this.orders.edit(me, id, body);
  }

  @Post('bulk/status')
  @HttpCode(200)
  bulkStatus(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: bulkStatusSchema })
    body: { ids: string[]; status: ApiOrderStatus },
  ) {
    return this.orders.bulkStatus(me, body.ids, body.status);
  }

  /** MOCK booking until the courier APIs are connected */
  @Post('bulk/courier')
  @HttpCode(200)
  bookCourier(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: courierBookSchema })
    body: { ids: string[]; courier: string },
  ) {
    return this.orders.bookCourier(me, body.ids, body.courier);
  }

  /** COD money received from the courier — money matters: manager/owner */
  @Post('bulk/settle')
  @HttpCode(200)
  @AdminOnly(...ROLE_GROUPS.manager)
  settle(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: settleSchema }) body: { ids: string[]; settled: boolean },
  ) {
    return this.orders.settle(me, body.ids, body.settled);
  }

  @Post(':id/status')
  @HttpCode(200)
  status(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: statusChangeSchema }) body: StatusChangeInput,
  ) {
    return this.orders.changeStatus(me, id, body.status, {
      note: body.note,
      restock: body.restock,
    });
  }

  @Post(':id/calls')
  @HttpCode(200)
  call(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: callSchema }) body: CallInput,
  ) {
    return this.orders.logCall(me, id, body);
  }

  @Patch(':id/note')
  note(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: adminNoteSchema }) body: { adminNote: string },
  ) {
    return this.orders.setAdminNote(me, id, body.adminNote);
  }

  @Post(':id/advance')
  @HttpCode(200)
  verifyAdvance(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: verifyAdvanceSchema }) body: { verified: boolean },
  ) {
    return this.orders.verifyAdvance(me, id, body.verified);
  }

  /** Refunds are money: manager/owner */
  @Post(':id/return')
  @HttpCode(200)
  @AdminOnly(...ROLE_GROUPS.manager)
  processReturn(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: returnSchema }) body: ReturnInput,
  ) {
    return this.orders.processReturn(me, id, body);
  }
}

@Controller('admin/blacklist')
@AdminOnly()
export class AdminBlacklistController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  list() {
    return this.prisma.blacklist.findMany({ orderBy: { createdAt: 'desc' } });
  }

  @Post()
  async add(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: blacklistSchema }) body: { phone: string; reason: string },
  ) {
    const row = await this.prisma.blacklist.upsert({
      where: { phone: body.phone },
      create: { ...body, createdBy: me.name },
      update: { reason: body.reason, createdBy: me.name },
    });
    await this.activity.log(
      me,
      'customer.blacklist',
      `${body.phone} blacklisted: ${body.reason}`,
    );
    return row;
  }

  @Delete(':phone')
  @HttpCode(204)
  async remove(
    @CurrentUser() me: AdminPrincipal,
    @Param('phone', { schema: phoneParam }) phone: string,
  ) {
    const { count } = await this.prisma.blacklist.deleteMany({
      where: { phone },
    });
    if (!count) throw new NotFoundException('Not on the blacklist');
    await this.activity.log(
      me,
      'customer.blacklist',
      `${phone} removed from blacklist`,
    );
  }
}
