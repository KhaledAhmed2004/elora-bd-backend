import {
  type ApiOrderStatus,
  type ApiPaymentMethod,
  fromDbEnum,
} from '../common/enums.js';
import type { Prisma } from '../generated/prisma/client.js';

export const ORDER_INCLUDE = {
  items: { orderBy: { id: 'asc' } },
  history: { orderBy: { createdAt: 'asc' } },
  calls: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.OrderInclude;

export type OrderRow = Prisma.OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

const attrs = (i: { color: string | null; size: string | null }) =>
  i.color || i.size
    ? {
        ...(i.color ? { color: i.color } : {}),
        ...(i.size ? { size: i.size } : {}),
      }
    : undefined;

/** Admin view — the frontend `Order` type, lower-case enums */
export function toAdminOrder(o: OrderRow) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    items: o.items.map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
      name: i.name,
      image: i.image ?? '/placeholder.svg',
      price: i.price,
      quantity: i.quantity,
      attributes: attrs(i),
      costPrice: i.costPrice ?? undefined,
    })),
    shippingAddress: {
      fullName: o.shipName,
      phone: o.shipPhone,
      division: o.division,
      district: o.district,
      upazila: o.upazila,
      address: o.address,
    },
    paymentMethod: fromDbEnum<ApiPaymentMethod>(o.paymentMethod),
    paymentStatus: fromDbEnum<'unpaid' | 'paid' | 'refunded'>(o.paymentStatus),
    status: fromDbEnum<ApiOrderStatus>(o.status),
    source: fromDbEnum(o.source),
    subtotal: o.subtotal,
    deliveryCharge: o.deliveryCharge,
    discount: o.discount,
    total: o.total,
    couponCode: o.couponCode ?? undefined,
    note: o.note ?? undefined,
    adminNote: o.adminNote ?? undefined,
    cancelReason: o.cancelReason ?? undefined,
    stockDeducted: o.stockDeducted,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    history: o.history.map((h) => ({
      status: fromDbEnum<ApiOrderStatus>(h.status),
      at: h.createdAt.toISOString(),
      note: h.note ?? undefined,
      by: h.actorName ?? undefined,
    })),
    callLog: o.calls.map((c) => ({
      at: c.createdAt.toISOString(),
      result: fromDbEnum(c.result),
      note: c.note ?? undefined,
      by: c.actorName ?? undefined,
    })),
    advance:
      o.advanceAmount != null
        ? {
            amount: o.advanceAmount,
            method: fromDbEnum<'bkash' | 'nagad'>(o.advanceMethod ?? 'BKASH'),
            trxId: o.advanceTrxId ?? '',
            senderNumber: o.advanceSender ?? undefined,
            verified: o.advanceVerified,
          }
        : null,
    courier: o.courierName
      ? {
          name: o.courierName,
          trackingId: o.trackingId ?? '',
          charge: o.courierCharge ?? undefined,
          settled: o.codSettled,
          settledAt: o.settledAt?.toISOString(),
        }
      : null,
    refund:
      o.refundAmount != null
        ? {
            amount: o.refundAmount,
            method: o.refundMethod ?? '',
            at: o.refundedAt?.toISOString() ?? '',
          }
        : null,
  };
}

/** Customer view (order success, tracking, account): no internal notes or costs */
export function toCustomerOrder(o: OrderRow) {
  const a = toAdminOrder(o);
  return {
    id: a.id,
    orderNumber: a.orderNumber,
    items: a.items.map(({ costPrice: _c, ...i }) => i),
    shippingAddress: a.shippingAddress,
    paymentMethod: a.paymentMethod,
    paymentStatus: a.paymentStatus,
    status: a.status,
    subtotal: a.subtotal,
    deliveryCharge: a.deliveryCharge,
    discount: a.discount,
    total: a.total,
    note: a.note,
    createdAt: a.createdAt,
    history: a.history.map(({ status, at }) => ({ status, at })),
    advance: a.advance
      ? {
          amount: a.advance.amount,
          method: a.advance.method,
          verified: a.advance.verified,
        }
      : null,
    courier: a.courier
      ? { name: a.courier.name, trackingId: a.courier.trackingId }
      : null,
  };
}
