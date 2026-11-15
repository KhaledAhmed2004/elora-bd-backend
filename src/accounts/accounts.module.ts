import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import { z } from 'zod';

import { ActivityService } from '../activity/activity.service.js';
import type { AdminPrincipal } from '../auth/auth.types.js';
import { AdminOnly, ROLE_GROUPS } from '../auth/roles.js';
import { dateRangeQuery } from '../common/dates.js';
import { PrismaService } from '../prisma/prisma.service.js';

const id = z.string().max(60);
const day = z.iso.date();
const taka = z.number().int().min(0).max(100_000_000);
/** Stored as a DATE; noon UTC keeps it on the same Bangladesh day */
const asDate = (d: string) => new Date(`${d}T12:00:00Z`);
const dateOut = (d: Date) => d.toISOString().slice(0, 10);

export const EXPENSE_CATEGORIES = [
  'Facebook Ad',
  'Packaging',
  'Salary',
  'Rent',
  'Internet/Phone',
  'Photoshoot',
  'Other',
] as const;

const expenseSchema = z.object({
  date: day,
  category: z.string().trim().min(2).max(40),
  amount: taka.min(1),
  note: z.string().trim().max(200).nullish(),
});
type ExpenseInput = z.infer<typeof expenseSchema>;

const supplierSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(20).nullish(),
  address: z.string().trim().max(200).nullish(),
  note: z.string().trim().max(300).nullish(),
});
type SupplierInput = z.infer<typeof supplierSchema>;

const purchaseSchema = z.object({
  date: day,
  supplierId: id,
  lines: z
    .array(
      z.object({
        productId: id,
        variantId: id.nullish(),
        quantity: z.number().int().min(1).max(100_000),
        unitCost: taka,
      }),
    )
    .min(1)
    .max(100),
  paid: taka.default(0),
  note: z.string().trim().max(200).nullish(),
  /** Latest purchase price becomes the product's cost price (profit reports) */
  updateCost: z.boolean().default(true),
});
type PurchaseInput = z.infer<typeof purchaseSchema>;

const paymentSchema = z.object({
  date: day,
  amount: taka.min(1),
  note: z.string().trim().max(200).nullish(),
});

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  // ───────── Expenses ─────────

  async expenses(range: { from?: string; to?: string }) {
    const where =
      range.from || range.to
        ? {
            date: {
              ...(range.from ? { gte: asDate(range.from) } : {}),
              ...(range.to ? { lte: asDate(range.to) } : {}),
            },
          }
        : {};
    const rows = await this.prisma.expense.findMany({
      where,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    });
    return {
      categories: EXPENSE_CATEGORIES,
      total: rows.reduce((s, e) => s + e.amount, 0),
      data: rows.map((e) => ({
        ...e,
        date: dateOut(e.date),
        note: e.note ?? undefined,
      })),
    };
  }

  async addExpense(me: AdminPrincipal, dto: ExpenseInput) {
    const e = await this.prisma.expense.create({
      data: { ...dto, date: asDate(dto.date), note: dto.note || null },
    });
    await this.activity.log(
      me,
      'accounts.expense',
      `Expense ৳${dto.amount} (${dto.category})`,
    );
    return { ...e, date: dateOut(e.date) };
  }

  async removeExpense(me: AdminPrincipal, expenseId: string) {
    const e = await this.prisma.expense.findUnique({
      where: { id: expenseId },
    });
    if (!e) throw new NotFoundException('Expense not found');
    await this.prisma.expense.delete({ where: { id: expenseId } });
    await this.activity.log(
      me,
      'accounts.expense',
      `Deleted expense ৳${e.amount} (${e.category})`,
    );
  }

  // ───────── Suppliers ─────────

  async suppliers() {
    const [rows, bought, payments] = await Promise.all([
      this.prisma.supplier.findMany({ orderBy: { name: 'asc' } }),
      this.prisma.purchase.groupBy({
        by: ['supplierId'],
        _sum: { total: true, paid: true },
        _count: { _all: true },
      }),
      this.prisma.supplierPayment.groupBy({
        by: ['supplierId'],
        _sum: { amount: true },
      }),
    ]);
    return rows.map((s) => {
      const b = bought.find((x) => x.supplierId === s.id);
      const paidLater =
        payments.find((x) => x.supplierId === s.id)?._sum.amount ?? 0;
      const total = b?._sum.total ?? 0;
      return {
        ...s,
        purchases: b?._count._all ?? 0,
        bought: total,
        due: total - (b?._sum.paid ?? 0) - paidLater,
      };
    });
  }

  async addSupplier(me: AdminPrincipal, dto: SupplierInput) {
    const s = await this.prisma.supplier.create({ data: dto });
    await this.activity.log(
      me,
      'stock.supplier',
      `Added supplier "${dto.name}"`,
      '/admin/purchases',
    );
    return s;
  }

  async updateSupplier(supplierId: string, dto: SupplierInput) {
    await this.supplier(supplierId);
    return this.prisma.supplier.update({
      where: { id: supplierId },
      data: dto,
    });
  }

  async removeSupplier(me: AdminPrincipal, supplierId: string) {
    const s = await this.supplier(supplierId);
    if (await this.prisma.purchase.count({ where: { supplierId } })) {
      throw new ConflictException('Suppliers with purchases cannot be deleted');
    }
    await this.prisma.supplier.delete({ where: { id: supplierId } });
    await this.activity.log(
      me,
      'stock.supplier',
      `Deleted supplier "${s.name}"`,
    );
  }

  async supplierLedger(supplierId: string) {
    const s = await this.supplier(supplierId);
    const [purchases, payments] = await Promise.all([
      this.prisma.purchase.findMany({
        where: { supplierId },
        include: { lines: true },
        orderBy: { date: 'desc' },
      }),
      this.prisma.supplierPayment.findMany({
        where: { supplierId },
        orderBy: { date: 'desc' },
      }),
    ]);
    const bought = purchases.reduce((n, p) => n + p.total, 0);
    const paid =
      purchases.reduce((n, p) => n + p.paid, 0) +
      payments.reduce((n, p) => n + p.amount, 0);
    return {
      supplier: s,
      bought,
      paid,
      due: bought - paid,
      purchases: purchases.map((p) => ({ ...p, date: dateOut(p.date) })),
      payments: payments.map((p) => ({ ...p, date: dateOut(p.date) })),
    };
  }

  async addPayment(
    me: AdminPrincipal,
    supplierId: string,
    dto: z.infer<typeof paymentSchema>,
  ) {
    const s = await this.supplier(supplierId);
    const p = await this.prisma.supplierPayment.create({
      data: {
        supplierId,
        amount: dto.amount,
        date: asDate(dto.date),
        note: dto.note || null,
      },
    });
    await this.activity.log(
      me,
      'stock.supplier-payment',
      `Paid ${s.name} ৳${dto.amount}`,
      '/admin/purchases',
    );
    return { ...p, date: dateOut(p.date) };
  }

  async removePayment(me: AdminPrincipal, paymentId: string) {
    const { count } = await this.prisma.supplierPayment.deleteMany({
      where: { id: paymentId },
    });
    if (!count) throw new NotFoundException('Payment not found');
    await this.activity.log(
      me,
      'stock.supplier-payment',
      'Deleted a supplier payment',
    );
  }

  // ───────── Purchases (stock in) ─────────

  async purchases(q: { supplierId?: string; page: number; limit: number }) {
    const where = q.supplierId ? { supplierId: q.supplierId } : {};
    const [rows, total] = await Promise.all([
      this.prisma.purchase.findMany({
        where,
        include: {
          lines: true,
          supplier: { select: { id: true, name: true } },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.purchase.count({ where }),
    ]);
    return {
      data: rows.map((p) => ({ ...p, date: dateOut(p.date) })),
      meta: {
        page: q.page,
        limit: q.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / q.limit)),
      },
    };
  }

  /** Saves the purchase and adds the quantities to stock, in one transaction */
  async addPurchase(me: AdminPrincipal, dto: PurchaseInput) {
    const supplier = await this.supplier(dto.supplierId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: dto.lines.map((l) => l.productId) } },
      include: { variants: { select: { id: true, color: true, size: true } } },
    });
    const lines = dto.lines.map((l) => {
      const p = products.find((x) => x.id === l.productId);
      if (!p) throw new BadRequestException('Product not found');
      const v = p.variants.find((x) => x.id === l.variantId);
      if (p.variants.length && !v) {
        throw new BadRequestException(`Pick a colour/size for "${p.name}"`);
      }
      return {
        ...l,
        variantId: v?.id ?? null,
        name: p.name,
        variant: v ? [v.color, v.size].filter(Boolean).join(' / ') : null,
      };
    });
    const total = lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);
    if (dto.paid > total)
      throw new BadRequestException('Paid cannot be more than the total');

    const purchase = await this.prisma.$transaction(async (tx) => {
      for (const l of lines) {
        if (l.variantId) {
          await tx.productVariant.update({
            where: { id: l.variantId },
            data: { stock: { increment: l.quantity } },
          });
        }
        await tx.product.update({
          where: { id: l.productId },
          data: {
            stock: { increment: l.quantity },
            ...(dto.updateCost ? { costPrice: l.unitCost } : {}),
          },
        });
      }
      return tx.purchase.create({
        data: {
          date: asDate(dto.date),
          supplierId: dto.supplierId,
          total,
          paid: dto.paid,
          note: dto.note || null,
          lines: { create: lines },
        },
        include: { lines: true },
      });
    });
    const qty = lines.reduce((s, l) => s + l.quantity, 0);
    await this.activity.log(
      me,
      'stock.purchase',
      `Stock in: ${qty} pcs from ${supplier.name} (৳${total})`,
      '/admin/purchases',
    );
    return { ...purchase, date: dateOut(purchase.date) };
  }

  /** Undo a wrong entry: removes its quantities from stock again (if they're still there) */
  async removePurchase(me: AdminPrincipal, purchaseId: string) {
    const p = await this.prisma.purchase.findUnique({
      where: { id: purchaseId },
      include: { lines: true },
    });
    if (!p) throw new NotFoundException('Purchase not found');
    await this.prisma.$transaction(async (tx) => {
      for (const l of p.lines) {
        if (l.variantId) {
          const { count } = await tx.productVariant.updateMany({
            where: { id: l.variantId, stock: { gte: l.quantity } },
            data: { stock: { decrement: l.quantity } },
          });
          if (!count)
            throw new ConflictException(
              `"${l.name}" has already been sold; adjust stock by hand`,
            );
        }
        const { count } = await tx.product.updateMany({
          where: { id: l.productId, stock: { gte: l.quantity } },
          data: { stock: { decrement: l.quantity } },
        });
        if (!count)
          throw new ConflictException(
            `"${l.name}" has already been sold; adjust stock by hand`,
          );
      }
      await tx.purchase.delete({ where: { id: purchaseId } });
    });
    await this.activity.log(
      me,
      'stock.purchase-delete',
      `Deleted purchase of ৳${p.total} (stock reversed)`,
    );
  }

  private async supplier(supplierId: string) {
    const s = await this.prisma.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!s) throw new NotFoundException('Supplier not found');
    return s;
  }
}

/** Money: manager or owner */
@Controller('admin')
@AdminOnly(...ROLE_GROUPS.manager)
export class AdminAccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get('expenses')
  expenses(
    @Query({ schema: dateRangeQuery }) range: { from?: string; to?: string },
  ) {
    return this.accounts.expenses(range);
  }

  @Post('expenses')
  addExpense(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: expenseSchema }) dto: ExpenseInput,
  ) {
    return this.accounts.addExpense(me, dto);
  }

  @Delete('expenses/:id')
  @HttpCode(204)
  removeExpense(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: id }) expenseId: string,
  ) {
    return this.accounts.removeExpense(me, expenseId);
  }

  @Get('suppliers')
  suppliers() {
    return this.accounts.suppliers();
  }

  @Post('suppliers')
  addSupplier(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: supplierSchema }) dto: SupplierInput,
  ) {
    return this.accounts.addSupplier(me, dto);
  }

  @Get('suppliers/:id')
  ledger(@Param('id', { schema: id }) supplierId: string) {
    return this.accounts.supplierLedger(supplierId);
  }

  @Put('suppliers/:id')
  updateSupplier(
    @Param('id', { schema: id }) supplierId: string,
    @Body({ schema: supplierSchema }) dto: SupplierInput,
  ) {
    return this.accounts.updateSupplier(supplierId, dto);
  }

  @Delete('suppliers/:id')
  @HttpCode(204)
  removeSupplier(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: id }) supplierId: string,
  ) {
    return this.accounts.removeSupplier(me, supplierId);
  }

  @Post('suppliers/:id/payments')
  addPayment(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: id }) supplierId: string,
    @Body({ schema: paymentSchema }) dto: z.infer<typeof paymentSchema>,
  ) {
    return this.accounts.addPayment(me, supplierId, dto);
  }

  @Delete('supplier-payments/:id')
  @HttpCode(204)
  removePayment(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: id }) paymentId: string,
  ) {
    return this.accounts.removePayment(me, paymentId);
  }

  @Get('purchases')
  purchases(
    @Query({
      schema: z.object({
        supplierId: id.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    })
    q: {
      supplierId?: string;
      page: number;
      limit: number;
    },
  ) {
    return this.accounts.purchases(q);
  }

  @Post('purchases')
  addPurchase(
    @CurrentUser() me: AdminPrincipal,
    @Body({ schema: purchaseSchema }) dto: PurchaseInput,
  ) {
    return this.accounts.addPurchase(me, dto);
  }

  @Delete('purchases/:id')
  @HttpCode(204)
  removePurchase(
    @CurrentUser() me: AdminPrincipal,
    @Param('id', { schema: id }) purchaseId: string,
  ) {
    return this.accounts.removePurchase(me, purchaseId);
  }
}

@Module({
  controllers: [AdminAccountsController],
  providers: [AccountsService],
})
export class AccountsModule {}
