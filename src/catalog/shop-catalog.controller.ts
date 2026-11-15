import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import { BannersService } from './banners.service.js';
import {
  type CouponCheck,
  couponCheckSchema,
  collectionParam,
  type FacetQuery,
  facetQuerySchema,
  limitQuery,
  type ProductQuery,
  productQuerySchema,
  slugParam,
  suggestQuery,
} from './catalog.schemas.js';
import { CategoriesService } from './categories.service.js';
import { CouponsService } from './coupons.service.js';
import { ProductsService } from './products.service.js';

/** Storefront catalog — no sign-in needed */
@Public()
@Controller()
export class ShopCatalogController {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly banners: BannersService,
    private readonly coupons: CouponsService,
  ) {}

  @Get('categories')
  categoryTree() {
    return this.categories.tree();
  }

  @Get('categories/:slug')
  category(@Param('slug', { schema: slugParam }) slug: string) {
    return this.categories.bySlug(slug);
  }

  @Get('products')
  list(@Query({ schema: productQuerySchema }) query: ProductQuery) {
    return this.products.list(query);
  }

  @Get('products/facets')
  facets(@Query({ schema: facetQuerySchema }) query: FacetQuery) {
    return this.products.facets(query);
  }

  /** featured | new-arrivals | best-sellers | flash-sale */
  @Get('products/collections/:name')
  collection(
    @Param('name', { schema: collectionParam })
    name: Parameters<ProductsService['collection']>[0],
    @Query({ schema: limitQuery }) { limit }: { limit: number },
  ) {
    return this.products.collection(name, limit);
  }

  @Get('products/suggest')
  suggest(@Query({ schema: suggestQuery }) { q }: { q: string }) {
    return this.products.suggest(q);
  }

  @Get('products/:slug')
  product(@Param('slug', { schema: slugParam }) slug: string) {
    return this.products.bySlug(slug);
  }

  @Get('products/:slug/related')
  related(
    @Param('slug', { schema: slugParam }) slug: string,
    @Query({ schema: limitQuery }) { limit }: { limit: number },
  ) {
    return this.products.related(slug, limit);
  }

  @Get('banners')
  activeBanners() {
    return this.banners.active();
  }

  /** Cart page coupon box. Rate-limited so codes can't be brute-forced */
  @Post('coupons/check')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  checkCoupon(@Body({ schema: couponCheckSchema }) body: CouponCheck) {
    return this.coupons.check(body.code, body.subtotal);
  }
}
