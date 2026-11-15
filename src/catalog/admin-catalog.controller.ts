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
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';

import type { AdminPrincipal } from '../auth/auth.types.js';
import { AdminOnly, ROLE_GROUPS } from '../auth/roles.js';
import { BannersService } from './banners.service.js';
import {
  type AdminProductQuery,
  adminProductQuerySchema,
  type BannerInput,
  bannerInputSchema,
  type CategoryInput,
  categoryInputSchema,
  type CouponInput,
  couponInputSchema,
  idParam,
  type ProductInput,
  productInputSchema,
  reorderSchema,
} from './catalog.schemas.js';
import { CategoriesService } from './categories.service.js';
import { CouponsService } from './coupons.service.js';
import { ProductsService } from './products.service.js';

/**
 * Catalog management. Reading is open to all staff (they pick products for
 * manual orders); changes need a manager or the owner.
 */
@Controller('admin/products')
@AdminOnly()
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Query({ schema: adminProductQuerySchema }) query: AdminProductQuery) {
    return this.products.adminList(query);
  }

  @Get(':id')
  get(@Param('id', { schema: idParam }) id: string) {
    return this.products.adminGet(id);
  }

  @Post()
  @AdminOnly(...ROLE_GROUPS.manager)
  create(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: productInputSchema }) dto: ProductInput,
  ) {
    return this.products.create(me, dto);
  }

  @Put(':id')
  @AdminOnly(...ROLE_GROUPS.manager)
  update(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: productInputSchema }) dto: ProductInput,
  ) {
    return this.products.update(me, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @AdminOnly(...ROLE_GROUPS.manager)
  remove(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
  ) {
    return this.products.remove(me, id);
  }
}

@Controller('admin/categories')
@AdminOnly()
export class AdminCategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  list() {
    return this.categories.listAll();
  }

  @Post()
  @AdminOnly(...ROLE_GROUPS.manager)
  create(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: categoryInputSchema }) dto: CategoryInput,
  ) {
    return this.categories.create(me, dto);
  }

  @Put(':id')
  @AdminOnly(...ROLE_GROUPS.manager)
  update(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: categoryInputSchema }) dto: CategoryInput,
  ) {
    return this.categories.update(me, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @AdminOnly(...ROLE_GROUPS.manager)
  remove(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
  ) {
    return this.categories.remove(me, id);
  }
}

@Controller('admin/banners')
@AdminOnly(...ROLE_GROUPS.manager)
export class AdminBannersController {
  constructor(private readonly banners: BannersService) {}

  @Get()
  list() {
    return this.banners.listAll();
  }

  @Post()
  create(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: bannerInputSchema }) dto: BannerInput,
  ) {
    return this.banners.create(me, dto);
  }

  /** Body: { ids: [...] } in display order */
  @Patch('order')
  reorder(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: reorderSchema }) { ids }: { ids: string[] },
  ) {
    return this.banners.reorder(me, ids);
  }

  @Put(':id')
  update(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
    @Body({ schema: bannerInputSchema }) dto: BannerInput,
  ) {
    return this.banners.update(me, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: idParam }) id: string,
  ) {
    return this.banners.remove(me, id);
  }
}

@Controller('admin/coupons')
@AdminOnly(...ROLE_GROUPS.manager)
export class AdminCouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @Get()
  list() {
    return this.coupons.list();
  }

  @Post()
  create(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: couponInputSchema }) dto: CouponInput,
  ) {
    return this.coupons.create(me, dto);
  }

  @Put(':code')
  update(
    @CurrentUser() me: AdminPrincipal,
    @Param('code', { schema: idParam }) code: string,
    @Body({ schema: couponInputSchema }) dto: CouponInput,
  ) {
    return this.coupons.update(me, code.toUpperCase(), dto);
  }

  @Delete(':code')
  @HttpCode(204)
  remove(
    @CurrentUser() me: AdminPrincipal,
    @Param('code', { schema: idParam }) code: string,
  ) {
    return this.coupons.remove(me, code.toUpperCase());
  }
}
