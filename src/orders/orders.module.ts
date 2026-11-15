import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module.js';
import {
  AdminBlacklistController,
  AdminOrdersController,
} from './admin-orders.controller.js';
import { CheckoutController } from './checkout.controller.js';
import { OrdersService } from './orders.service.js';
import { PricingService } from './pricing.service.js';
import { RiskService } from './risk.service.js';

@Module({
  imports: [CatalogModule],
  controllers: [
    CheckoutController,
    AdminOrdersController,
    AdminBlacklistController,
  ],
  providers: [OrdersService, PricingService, RiskService],
  exports: [OrdersService, RiskService],
})
export class OrdersModule {}
