import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

import {
  type LeadInput,
  leadSchema,
  type PlaceOrderInput,
  placeOrderSchema,
  type QuoteInput,
  quoteSchema,
  type TrackInput,
  trackSchema,
} from './orders.schemas.js';
import { OrdersService } from './orders.service.js';
import { PricingService } from './pricing.service.js';

/** Storefront checkout — no sign-in, rate-limited per IP */
@Public()
@Controller()
@UseGuards(ThrottlerGuard)
export class CheckoutController {
  constructor(
    private readonly orders: OrdersService,
    private readonly pricing: PricingService,
  ) {}

  /** Cart/checkout totals with live prices, stock, coupon and delivery charge */
  @Post('checkout/quote')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  quote(@Body({ schema: quoteSchema }) body: QuoteInput) {
    return this.pricing.quote(body);
  }

  @Post('orders')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  place(@Body({ schema: placeOrderSchema }) body: PlaceOrderInput) {
    return this.orders.place(body);
  }

  @Post('orders/track')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  track(@Body({ schema: trackSchema }) body: TrackInput) {
    return this.orders.track(body.orderNumber, body.phone);
  }

  /** Phone + cart saved while the customer is still on the checkout page */
  @Post('checkout/lead')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  lead(@Body({ schema: leadSchema }) body: LeadInput) {
    return this.orders.captureLead(body);
  }
}
