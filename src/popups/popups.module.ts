import { Module } from '@nestjs/common';

import {
  AdminPopupsController,
  ShopPopupsController,
} from './popups.controller.js';
import { PopupsService } from './popups.service.js';

@Module({
  controllers: [ShopPopupsController, AdminPopupsController],
  providers: [PopupsService],
})
export class PopupsModule {}
