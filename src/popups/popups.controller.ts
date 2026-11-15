import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { z } from 'zod';

import type { AdminPrincipal } from '../auth/auth.types.js';
import { AdminOnly, ROLE_GROUPS } from '../auth/roles.js';
import {
  type PopupEvent,
  popupEventSchema,
  type PopupInput,
  popupInputSchema,
} from './popups.schemas.js';
import { PopupsService } from './popups.service.js';

const idParam = z.string().min(1).max(60);
const activeSchema = z.object({ active: z.boolean() });

/** Storefront: no sign-in needed */
@Public()
@Controller('popups')
export class ShopPopupsController {
  constructor(private readonly popups: PopupsService) {}

  @Get()
  live() {
    return this.popups.live();
  }

  /** Body: { type: "view" | "click" }. Rate-limited per IP. */
  @Post(':id/events')
  @HttpCode(204)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  track(
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: popupEventSchema }) body: PopupEvent,
  ) {
    return this.popups.track(id, body);
  }
}

@Controller('admin/popups')
@AdminOnly(...ROLE_GROUPS.manager)
export class AdminPopupsController {
  constructor(private readonly popups: PopupsService) {}

  @Get()
  list() {
    return this.popups.listAll();
  }

  @Post()
  create(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: popupInputSchema }) dto: PopupInput,
  ) {
    return this.popups.create(me, dto);
  }

  @Put(':id')
  update(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: popupInputSchema }) dto: PopupInput,
  ) {
    return this.popups.update(me, id, dto);
  }

  @Patch(':id/active')
  setActive(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: activeSchema }) { active }: { active: boolean },
  ) {
    return this.popups.setActive(me, id, active);
  }

  @Post(':id/duplicate')
  duplicate(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
  ) {
    return this.popups.duplicate(me, id);
  }

  @Post(':id/reset-stats')
  @HttpCode(200)
  resetStats(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
  ) {
    return this.popups.resetStats(me, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
  ) {
    return this.popups.remove(me, id);
  }
}
