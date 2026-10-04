import type { AdminOrderQuery, OrderStatus, PaymentMethod, PaymentOption, ShippingOption } from '@ecom/contracts';
import { EXPRESS_SHIPPING, codEligibility, computeServiceability, deliverabilityProblem, shippingFee } from '@ecom/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Services } from '../container';
import { type AuthedRequest, csrf, mustUser, optionalAuth, requireAuth, userOf } from '../http/auth';
import { ensureGuestCartToken, ownerKeyFor, readGuestCartToken } from '../http/cookies';
import { AppError } from '../http/errors';
import type { Routes } from '../http/route';
import { int as intField, nested, oneOf, optional, str } from '../http/validate';
import type { OwnerContext } from '../commerce/order-service';

const DAY_MS = 86_400_000;
const STATUSES: OrderStatus[] = ['pending_payment', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'];
const PAYMENT_METHODS: PaymentMethod[] = ['razorpay', 'cod'];

const int = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

function assertDeliverable(pincode: string): void {
  const problem = deliverabilityProblem(pincode, (p) => computeServiceability(p).serviceable);
  if (problem === 'invalid') throw new AppError('validation', 'Enter a valid 6-digit pin code', { pincode: 'Invalid pin code' });
  if (problem === 'not_deliverable') throw new AppError('validation', 'Sorry, we do not deliver to this pin code yet.', { pincode: 'Not deliverable' });
}

/** Who is asking: the signed-in user, or the browser identified by the guest cart cookie. */
const ownerOf = (req: Request): OwnerContext => {
  const user = userOf(req);
  return user ? { userId: user.id } : { guestToken: readGuestCartToken(req) ?? '' };
};

export function commerceRoutes(r: Routes, s: Services): void {
  const { config } = s;
  const secure = config.production;
  const optional_ = optionalAuth(config);
  /** The cart/order key of this request, minting the guest cookie the first time it is needed. */
  const cartKey = (req: Request, res: Response): string => ownerKeyFor(userOf(req)?.id, ensureGuestCartToken(req, res, secure));

  // ---- cart -------------------------------------------------------------------------------------------------
  r.get('/cart', { guards: [optional_] }, (req, res) => s.cart.get(cartKey(req, res)));
  r.post('/cart/items', { guards: [optional_, csrf], body: { variantId: str(), quantity: intField(1) } }, (req, res) => s.cart.add(cartKey(req, res), req.body.variantId, req.body.quantity));
  r.put('/cart/items/:variantId', { guards: [optional_, csrf], body: { quantity: intField(0) } }, (req, res) => s.cart.setQuantity(cartKey(req, res), req.params['variantId'], req.body.quantity));
  r.delete('/cart/items/:variantId', { guards: [optional_, csrf] }, (req, res) => s.cart.remove(cartKey(req, res), req.params['variantId']));
  r.post('/cart/coupon', { bucket: 'coupon', guards: [optional_, csrf], body: { code: str() } }, (req, res) => s.cart.applyCoupon(cartKey(req, res), req.body.code));
  r.delete('/cart/coupon', { guards: [optional_, csrf] }, (req, res) => s.cart.removeCoupon(cartKey(req, res)));
  r.put('/cart/shipping-method', { guards: [optional_, csrf], body: { method: oneOf('standard', 'express') } }, (req, res) => s.cart.setShippingMethod(cartKey(req, res), req.body.method));
  r.delete('/cart', { guards: [optional_, csrf] }, (req, res) => s.cart.clear(cartKey(req, res)));

  // ---- checkout options ---------------------------------------------------------------------------------------
  r.get('/checkout/shipping-options/:pincode', { guards: [optional_] }, async (req, res): Promise<ShippingOption[]> => {
    const pincode = req.params['pincode'];
    assertDeliverable(pincode);
    const cart = await s.cart.get(cartKey(req, res));
    const base = computeServiceability(pincode);
    const afterDiscount = cart.totals.subtotal.amount - cart.totals.couponDiscount.amount;
    const free = cart.coupon?.freeShipping ?? false;
    const standardDays = base.estimatedDays ?? 3;
    const expressDays = Math.max(1, standardDays - 2);
    const on = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
    return [
      { id: 'standard', label: 'Standard delivery', price: { amount: shippingFee('standard', afterDiscount, free), currency: 'INR' }, estimatedDays: standardDays, estimatedDate: on(standardDays) },
      { id: 'express', label: 'Express delivery', price: { amount: free ? 0 : EXPRESS_SHIPPING, currency: 'INR' }, estimatedDays: expressDays, estimatedDate: on(expressDays) },
    ];
  });

  r.get('/checkout/payment-options/:pincode', { guards: [optional_] }, async (req, res): Promise<PaymentOption[]> => {
    const pincode = req.params['pincode'];
    assertDeliverable(pincode);
    const cart = await s.cart.get(cartKey(req, res));
    const cod = codEligibility(pincode, cart.totals.total.amount);
    return [
      { method: 'razorpay', label: 'Pay online (UPI, cards, net banking, wallets)', enabled: true },
      { method: 'cod', label: 'Cash on delivery', enabled: cod.enabled, ...(cod.reason ? { reason: cod.reason } : {}) },
    ];
  });

  // ---- orders -------------------------------------------------------------------------------------------------
  const address = nested({ line1: str(200), line2: optional(str(200)), city: str(100), state: str(100), pincode: str(10) });
  const contact = nested({ name: str(120), email: str(200), phone: str(20) });

  r.post('/orders', { bucket: 'checkout', guards: [optional_, csrf], body: { idempotencyKey: str(100), contact, address, paymentMethod: oneOf('razorpay', 'cod') } }, (req, res) => {
    const guestToken = ensureGuestCartToken(req, res, secure);
    const user = userOf(req);
    return s.orders.place(ownerKeyFor(user?.id, guestToken), user ? { userId: user.id } : { guestToken }, req.body);
  });

  r.get('/orders/:id', { guards: [optional_] }, (req) => s.orders.get(req.params['id'], ownerOf(req)));

  /**
   * Checks order ownership as a guard, before the stream opens, so a non-owner gets an ordinary 404 instead of a 200
   * with an error event inside the stream.
   */
  const streamOwnership: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    s.orders.get(req.params['id'], ownerOf(req)).then(
      () => next(),
      (error) => next(error),
    );
  };

  /** Real-time order tracking: a status change reaches an open tracking page over Server-Sent Events. */
  r.get('/orders/:id/stream', { guards: [optional_, streamOwnership] }, async (req, res) => {
    const current = await s.orders.get(req.params['id'], ownerOf(req));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const stop = s.orderEvents.observe(
      req.params['id'],
      current,
      (order) => res.write(`data: ${JSON.stringify(order)}\n\n`),
      () => res.end(),
    );
    res.on('close', stop);
    return undefined;
  });

  r.get('/orders', { guards: [optional_] }, (req) => s.orders.list(ownerOf(req)));
  r.post('/orders/:id/cancel', { status: 200, guards: [optional_, csrf] }, (req) => s.orders.cancel(req.params['id'], ownerOf(req)));

  // ---- payments -----------------------------------------------------------------------------------------------
  r.post('/orders/:id/payment/initiate', { guards: [optional_, csrf] }, (req) => s.payments.initiate(req.params['id'], ownerOf(req)));
  r.post('/orders/:id/payment/confirm', { guards: [optional_, csrf], body: { providerPaymentId: str(), providerOrderId: str(), signature: str() } }, (req) => s.payments.confirm(req.params['id'], ownerOf(req), req.body));
  r.post('/orders/:id/payment/fail', { status: 200, guards: [optional_, csrf], body: { reason: str() } }, (req) => s.payments.fail(req.params['id'], ownerOf(req), req.body.reason));

  /**
   * Razorpay calls this directly; it never goes through a browser, so there is no cookie or bearer session and no CSRF
   * concern: the webhook signature, checked against the untouched raw body, is the only authentication. It is idempotent.
   */
  r.post('/webhooks/razorpay', { status: 200 }, (req: AuthedRequest) => s.payments.webhook(req.rawBody, req.headers['x-razorpay-signature'] as string | undefined));

  // ---- back-office orders -------------------------------------------------------------------------------------
  const readAny = requireAuth(config, 'order:read:any');
  r.get('/admin/orders', { guards: [readAny] }, (req) => {
    const q = req.query as Record<string, string>;
    const query: AdminOrderQuery = {
      ...(q['q'] ? { q: q['q'] } : {}),
      ...(q['status'] && STATUSES.includes(q['status'] as OrderStatus) ? { status: q['status'] as OrderStatus } : {}),
      ...(q['paymentMethod'] && PAYMENT_METHODS.includes(q['paymentMethod'] as PaymentMethod) ? { paymentMethod: q['paymentMethod'] as PaymentMethod } : {}),
      ...(q['from'] ? { from: q['from'] } : {}),
      ...(q['to'] ? { to: q['to'] } : {}),
      page: int(q['page'], 1),
      pageSize: Math.min(200, int(q['pageSize'], 20)),
    };
    return s.adminOrders.list(query);
  });
  r.get('/admin/orders/:id', { guards: [readAny] }, (req) => s.adminOrders.get(req.params['id']));
  r.patch('/admin/orders/:id/status', { guards: [requireAuth(config, 'order:refund')], body: { status: oneOf(...STATUSES) } }, (req) => s.adminOrders.advance(req.params['id'], req.body.status, mustUser(req).id));
  r.post('/admin/orders/:id/notes', { guards: [readAny], body: { text: str(2000) } }, (req) => s.adminOrders.addNote(req.params['id'], mustUser(req).id, req.body.text));
}
