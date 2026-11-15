import { Module } from '@nestjs/common';

import {
  AdminBannersController,
  AdminCategoriesController,
  AdminCouponsController,
  AdminProductsController,
} from './admin-catalog.controller.js';
import { BannersService } from './banners.service.js';
import { CategoriesService } from './categories.service.js';
import { CouponsService } from './coupons.service.js';
import { ProductsService } from './products.service.js';
import { ShopCatalogController } from './shop-catalog.controller.js';

@Module({
  controllers: [
    ShopCatalogController,
    AdminProductsController,
    AdminCategoriesController,
    AdminBannersController,
    AdminCouponsController,
  ],
  providers: [
    ProductsService,
    CategoriesService,
    BannersService,
    CouponsService,
  ],
  // Checkout (next step) prices carts and validates coupons with these
  exports: [ProductsService, CouponsService],
})
export class CatalogModule {}
