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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, Public } from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { z } from 'zod';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { AdminOnly } from '../auth/roles.js';
import { fromDbEnum, toDbEnum } from '../common/enums.js';
import { bdPhone } from '../common/phone.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { ReviewStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

const STATUSES = ['pending', 'approved', 'hidden'] as const;

const submitSchema = z.object({
  name: z.string().trim().min(2, 'Please enter your name').max(40),
  phone: bdPhone.optional().or(z.literal('')),
  rating: z.number().int().min(1).max(5),
  text: z.string().trim().min(10, 'Please write at least 10 characters').max(600),
});
type SubmitInput = z.infer<typeof submitSchema>;

const adminQuery = z.object({
  status: z.enum(STATUSES).optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  productId: z.string().max(60).optional(),
  q: z.string().trim().max(60).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
type AdminQuery = z.infer<typeof adminQuery>;

const idList = z.array(z.string().max(60)).min(1).max(200);
const statusSchema = z.object({ ids: idList, status: z.enum(STATUSES) });
const replySchema = z.object({ reply: z.string().trim().max(500) });
const slug = z.string().min(2).max(120);

@Injectable()
export class ReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async approvedFor(slugValue: string) {
    const product = await this.productBySlug(slugValue);
    const rows = await this.prisma.review.findMany({
      where: { productId: product.id, status: 'APPROVED' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      rating: r.rating,
      text: r.text,
      date: r.createdAt.toISOString(),
      verified: r.verified,
      reply: r.reply ?? undefined,
    }));
  }

  /** New reviews wait for approval. "Verified" = a delivered order of this product to that number. */
  async submit(slugValue: string, input: SubmitInput) {
    const product = await this.productBySlug(slugValue);
    const phone = input.phone || null;
    const [delivered, customer] = phone
      ? await Promise.all([
          this.prisma.order.count({
            where: {
              shipPhone: phone,
              status: 'DELIVERED',
              items: { some: { productId: product.id } },
            },
          }),
          this.prisma.customer.findUnique({
            where: { phone },
            select: { id: true },
          }),
        ])
      : [0, null];
    await this.prisma.review.create({
      data: {
        productId: product.id,
        customerId: customer?.id,
        name: input.name,
        phone,
        rating: input.rating,
        text: input.text,
        verified: delivered > 0,
      },
    });
    return {
      ok: true,
      message: 'Thank you! Your review will appear once it has been approved.',
    };
  }

  async list(q: AdminQuery) {
    const where: Prisma.ReviewWhereInput = {};
    if (q.status) where.status = toDbEnum<ReviewStatus>(q.status);
    if (q.rating) where.rating = q.rating;
    if (q.productId) where.productId = q.productId;
    if (q.q) {
      where.OR = [
        { name: { contains: q.q, mode: 'insensitive' } },
        { text: { contains: q.q, mode: 'insensitive' } },
        { product: { name: { contains: q.q, mode: 'insensitive' } } },
      ];
    }
    const [rows, total, counts] = await Promise.all([
      this.prisma.review.findMany({
        where,
        include: { product: { select: { id: true, name: true, slug: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.review.count({ where }),
      this.prisma.review.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return {
      data: rows.map(({ product, ...r }) => ({
        id: r.id,
        productId: product.id,
        productName: product.name,
        productSlug: product.slug,
        name: r.name,
        phone: r.phone ?? undefined,
        rating: r.rating,
        text: r.text,
        status: fromDbEnum(r.status),
        verified: r.verified,
        reply: r.reply ?? undefined,
        createdAt: r.createdAt.toISOString(),
      })),
      counts: Object.fromEntries(
        counts.map((c) => [fromDbEnum(c.status), c._count._all]),
      ),
      meta: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      },
    };
  }

  async setStatus(
    me: AdminPrincipal,
    ids: string[],
    status: (typeof STATUSES)[number],
  ) {
    const products = await this.productsOf(ids);
    const { count } = await this.prisma.review.updateMany({
      where: { id: { in: ids } },
      data: { status: toDbEnum<ReviewStatus>(status) },
    });
    await this.refreshRatings(products);
    await this.activity.log(
      me,
      'review.moderate',
      `${count} review(s) → ${status}`,
      '/admin/reviews',
    );
    return { updated: count };
  }

  async reply(me: AdminPrincipal, id: string, reply: string) {
    const r = await this.prisma.review.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Review not found');
    await this.prisma.review.update({
      where: { id },
      data: { reply: reply || null },
    });
    await this.activity.log(
      me,
      'review.reply',
      `Replied to ${r.name}'s review`,
      '/admin/reviews',
    );
    return { ok: true };
  }

  async remove(me: AdminPrincipal, ids: string[]) {
    const products = await this.productsOf(ids);
    const { count } = await this.prisma.review.deleteMany({
      where: { id: { in: ids } },
    });
    await this.refreshRatings(products);
    await this.activity.log(
      me,
      'review.delete',
      `Deleted ${count} review(s)`,
      '/admin/reviews',
    );
  }

  /** Stars and count on the product come from approved reviews only */
  private async refreshRatings(productIds: string[]) {
    for (const productId of productIds) {
      const agg = await this.prisma.review.aggregate({
        where: { productId, status: 'APPROVED' },
        _avg: { rating: true },
        _count: { _all: true },
      });
      await this.prisma.product.update({
        where: { id: productId },
        data: { ratingAvg: agg._avg.rating ?? 0, reviewCount: agg._count._all },
      });
    }
  }

  private async productsOf(ids: string[]) {
    const rows = await this.prisma.review.findMany({
      where: { id: { in: ids } },
      select: { productId: true },
      distinct: ['productId'],
    });
    return rows.map((r) => r.productId);
  }

  private async productBySlug(s: string) {
    const product = await this.prisma.product.findFirst({
      where: { slug: s, status: { in: ['ACTIVE', 'HIDDEN'] } },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }
}

@Public()
@Controller('products/:slug/reviews')
export class ShopReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Param('slug', { schema: slug }) s: string) {
    return this.reviews.approvedFor(s);
  }

  @Post()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  submit(
    @Param('slug', { schema: slug }) s: string,
    @Body({ schema: submitSchema }) body: SubmitInput,
  ) {
    return this.reviews.submit(s, body);
  }
}

@Controller('admin/reviews')
@AdminOnly()
export class AdminReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get()
  list(@Query({ schema: adminQuery }) q: AdminQuery) {
    return this.reviews.list(q);
  }

  @Post('status')
  @HttpCode(200)
  status(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: statusSchema }) body: z.infer<typeof statusSchema>,
  ) {
    return this.reviews.setStatus(me, body.ids, body.status);
  }

  @Patch(':id/reply')
  reply(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: z.string().max(60) }) id: string,
    @Body({ schema: replySchema }) body: { reply: string },
  ) {
    return this.reviews.reply(me, id, body.reply);
  }

  @Delete()
  @HttpCode(204)
  remove(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: z.object({ ids: idList }) }) body: { ids: string[] },
  ) {
    return this.reviews.remove(me, body.ids);
  }
}

@Module({
  controllers: [ShopReviewsController, AdminReviewsController],
  providers: [ReviewsService],
})
export class ReviewsModule {}
