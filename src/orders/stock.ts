import { ConflictException } from '@nestjs/common';

import type { Prisma } from '../generated/prisma/client.js';

type Tx = Prisma.TransactionClient;

export interface StockLine {
  productId: string | null;
  variantId: string | null;
  name: string;
  quantity: number;
}

/**
 * Takes items out of stock. Each decrement is one conditional UPDATE
 * (`… WHERE stock >= qty`), so two staff confirming orders for the last
 * piece at the same moment can't both succeed.
 */
export async function deductStock(tx: Tx, lines: StockLine[]) {
  for (const l of lines) {
    if (!l.productId) continue; // product was deleted: nothing to track
    if (l.variantId) {
      const { count } = await tx.productVariant.updateMany({
        where: { id: l.variantId, stock: { gte: l.quantity } },
        data: { stock: { decrement: l.quantity } },
      });
      if (count === 0) {
        const exists = await tx.productVariant.count({
          where: { id: l.variantId },
        });
        if (!exists) continue; // variant deleted since the order was placed
        throw new ConflictException(`Not enough stock for "${l.name}"`);
      }
      await tx.product.update({
        where: { id: l.productId },
        data: { stock: { decrement: l.quantity } },
      });
    } else {
      const { count } = await tx.product.updateMany({
        where: { id: l.productId, stock: { gte: l.quantity } },
        data: { stock: { decrement: l.quantity } },
      });
      if (count === 0) {
        const exists = await tx.product.count({ where: { id: l.productId } });
        if (!exists) continue;
        throw new ConflictException(`Not enough stock for "${l.name}"`);
      }
    }
  }
}

/** Puts items back (cancel, return, edit). Deleted products/variants are skipped. */
export async function restock(tx: Tx, lines: StockLine[]) {
  for (const l of lines) {
    if (!l.productId) continue;
    if (l.variantId) {
      const { count } = await tx.productVariant.updateMany({
        where: { id: l.variantId },
        data: { stock: { increment: l.quantity } },
      });
      if (!count) continue;
    }
    await tx.product.updateMany({
      where: { id: l.productId },
      data: { stock: { increment: l.quantity } },
    });
  }
}

/** Best-seller counter: +qty when delivered, −qty if that delivery is returned */
export async function adjustSold(
  tx: Tx,
  lines: StockLine[],
  direction: 1 | -1,
) {
  for (const l of lines) {
    if (!l.productId) continue;
    await tx.product.updateMany({
      where: { id: l.productId },
      data: { soldCount: { increment: direction * l.quantity } },
    });
  }
}
