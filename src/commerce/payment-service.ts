import { randomBytes } from 'node:crypto';
import type { CartTotals, Order, OrderNote, PaymentResult, PaymentSession, ShippingMethodId, TimelineEntry } from '@ecom/contracts';
import type { ApiConfig } from '../config';
import { Logger } from '../logger';
import { AppError } from '../http/errors';
import type { Db } from '../db/prisma';
import { CartService } from './cart-service';
import { InventoryService } from './inventory';
import { fromJson, toJson } from './json';
import { OrderService, type OwnerContext, PAYMENT_WINDOW_MINUTES, stockLinesOf } from './order-service';
import { ownerKeyFor } from '../http/cookies';
import { RazorpayService } from './razorpay';
import { OutboxService } from '../messaging/outbox';
import { OrderEventsService } from '../messaging/order-events';

/** Payments (BRD 21, CM21-05): initiate creates the Razorpay order the checkout widget needs; confirm
 * verifies the signature server-side before an order is ever marked paid — the amount always comes from
 * the order the server already priced, never from anything the client sends. */
export class PaymentService {
  private readonly logger = new Logger('RazorpayWebhook');

  constructor(
    private readonly db: Db,
    private readonly orders: OrderService,
    private readonly cart: CartService,
    private readonly inventory: InventoryService,
    private readonly razorpay: RazorpayService,
    private readonly outbox: OutboxService,
    private readonly orderEvents: OrderEventsService,
    private readonly config: ApiConfig,
  ) {}

  async initiate(orderId: string, owner: OwnerContext): Promise<PaymentSession> {
    await this.orders.sweepExpired();
    let row = await this.orders.getRowForOwner(orderId, owner);
    if (row.status !== 'pending_payment') throw new AppError('validation', 'This order does not need a payment.');
    if (row.paymentStatus === 'failed') {
      // A previous attempt released the stock hold; reclaim it before letting them try again.
      await this.inventory.take(stockLinesOf(row));
      row = await this.db.order.update({
        where: { id: orderId },
        data: { paymentStatus: 'pending', paymentDeadline: new Date(Date.now() + PAYMENT_WINDOW_MINUTES * 60_000) },
      });
    }
    const amount = fromJson<CartTotals>(row.totals).total.amount;
    const provider = await this.razorpay.createOrder(amount, row.id);
    await this.db.order.update({ where: { id: orderId }, data: { providerOrderId: provider.id } });
    return { orderId, providerOrderId: provider.id, keyId: this.config.razorpayKeyId, amount, currency: 'INR' };
  }

  async confirm(orderId: string, owner: OwnerContext, result: PaymentResult): Promise<Order> {
    await this.orders.sweepExpired();
    const row = await this.orders.getRowForOwner(orderId, owner);
    if (row.paymentStatus === 'paid') return this.orders.toContract(row);
    if (row.status === 'cancelled') throw new AppError('validation', 'The payment window for this order expired and its items were released. Please place the order again.');
    if (row.status !== 'pending_payment') throw new AppError('validation', 'This order can no longer be paid.');
    const valid = result.providerOrderId === row.providerOrderId && this.razorpay.verifyPaymentSignature(result.providerOrderId, result.providerPaymentId, result.signature);
    if (!valid) throw new AppError('validation', 'Payment verification failed. If money was deducted it will be refunded.');
    const now = new Date().toISOString();
    const timeline: TimelineEntry[] = [...fromJson<TimelineEntry[]>(row.timeline), { status: 'paid', label: 'Payment received', at: now }, { status: 'confirmed', label: 'Order confirmed', at: now }];
    const updated = await this.db.$transaction(async (tx) => {
      const updatedRow = await tx.order.update({ where: { id: orderId }, data: { status: 'confirmed', paymentStatus: 'paid', providerPaymentId: result.providerPaymentId, timeline: toJson(timeline) } });
      await this.outbox.write(tx, 'payment.confirmed', { orderId, email: row.contactEmail, name: row.contactName, amount: fromJson<CartTotals>(row.totals).total });
      return updatedRow;
    });
    await this.cart.replaceWithEmpty(ownerKeyFor(owner.userId, owner.guestToken ?? ''), row.shippingMethod as ShippingMethodId);
    const contract = this.orders.toContract(updated);
    await this.orderEvents.publish(contract);
    return contract;
  }

  async fail(orderId: string, owner: OwnerContext, reason: string): Promise<Order> {
    const row = await this.orders.getRowForOwner(orderId, owner);
    if (row.paymentStatus === 'paid') return this.orders.toContract(row);
    // A failed payment gives its stock back; a retry (via initiate) claims it again.
    await this.inventory.giveBack(stockLinesOf(row));
    const note: OrderNote = { id: `note_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, at: new Date().toISOString(), author: 'system', text: `Payment attempt failed: ${reason}` };
    const updated = await this.db.order.update({ where: { id: orderId }, data: { paymentStatus: 'failed', notes: toJson([note, ...fromJson<OrderNote[]>(row.notes)]) } });
    return this.orders.toContract(updated);
  }

  /**
   * Razorpay's webhook: authenticated only by its signature over the untouched raw body. Always answers `{ ok: true }`, so
   * an attacker learns nothing about what a valid signature looks like, and is idempotent: an event already applied
   * (order already paid or cancelled) is acknowledged again without re-applying it.
   */
  async webhook(rawBody: string | undefined, signature: string | undefined): Promise<{ ok: true }> {
    if (!signature || !rawBody || !this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Rejected a webhook call with a missing or invalid signature.');
      return { ok: true };
    }
    const event = JSON.parse(rawBody) as { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } } } };
    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id) return { ok: true };
    const order = await this.db.order.findFirst({ where: { providerOrderId: payment.order_id } });
    if (!order) return { ok: true };

    if (event.event === 'payment.captured' && order.paymentStatus !== 'paid' && order.status === 'pending_payment') {
      const now = new Date().toISOString();
      const timeline = [...fromJson<{ status: string; label: string; at?: string }[]>(order.timeline), { status: 'paid', label: 'Payment received', at: now }, { status: 'confirmed', label: 'Order confirmed', at: now }];
      await this.db.order.update({ where: { id: order.id }, data: { status: 'confirmed', paymentStatus: 'paid', providerPaymentId: payment.id ?? null, timeline: toJson(timeline) } });
      this.logger.log(`Webhook confirmed payment for order ${order.id}`);
    } else if (event.event === 'payment.failed' && order.paymentStatus === 'pending') {
      await this.inventory.giveBack(stockLinesOf(order));
      await this.db.order.update({ where: { id: order.id }, data: { paymentStatus: 'failed' } });
      this.logger.log(`Webhook recorded a failed payment for order ${order.id}`);
    }
    return { ok: true };
  }
}
