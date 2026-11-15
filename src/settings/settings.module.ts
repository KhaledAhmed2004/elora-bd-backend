import { Body, Controller, Get, Global, Module, Put } from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';

import type { AdminPrincipal } from '../auth/auth.types.js';
import { AdminOnly, ROLE_GROUPS } from '../auth/roles.js';
import type { StoreSettings } from './settings.defaults.js';
import { SettingsService, storeSettingsSchema } from './settings.service.js';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** Shop header/footer, checkout charges and payment options */
  @Public()
  @Get('settings')
  publicSettings() {
    return this.settings.getPublic();
  }

  @AdminOnly()
  @Get('admin/settings')
  all() {
    return this.settings.get();
  }

  @AdminOnly(...ROLE_GROUPS.owner)
  @Put('admin/settings')
  update(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: storeSettingsSchema }) body: StoreSettings,
  ) {
    return this.settings.update(me, body);
  }
}

@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
