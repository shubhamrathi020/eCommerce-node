import { loadConfig } from '../config';
import { Db } from '../db/prisma';
import { OutboxService } from './outbox';
import { SchedulerService } from './scheduler';

// Needs the test PostgreSQL (the same one the Nest API's specs use, already migrated by eCommerce-api).
const url = process.env['TEST_DATABASE_URL'] ?? 'postgresql://ecommerce:ecommerce@localhost:5432/ecommerce_test?schema=public';
const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: url, MONGODB_URL: 'mongodb://x', MEILI_URL: 'http://x', REDIS_URL: 'redis://x', RABBITMQ_URL: 'amqp://x', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_REFRESH_SECRET: 'b'.repeat(32) });

describe('SchedulerService.remindAbandonedCarts', () => {
  const db = new Db(url);
  let reachable = true;
  beforeAll(async () => {
    try {
      await db.$queryRaw`SELECT 1 FROM carts LIMIT 1`;
    } catch {
      reachable = false;
    }
  });
  afterAll(() => db.$disconnect());

  it('reminds a signed-in customer about an abandoned cart once, and stays quiet for a fresh one', async (ctx) => {
    if (!reachable) return ctx.skip();
    const email = `rina-node-test-${Date.now()}@example.com`;
    const user = await db.user.create({ data: { name: 'Rina Shah', email, passwordHash: 'hash', verifyTokenHash: `verify-${Date.now()}` } });
    const ownerKey = `user:${user.id}`;
    try {
      await db.cart.create({ data: { ownerKey, items: [{ variantId: 'p-0002-v1', quantity: 2, seenPrice: 100 }] } });
      const scheduler = new SchedulerService(db, undefined as never, undefined as never, new OutboxService(db), config);
      const reminders = () => db.outboxEvent.count({ where: { routingKey: 'cart.abandoned', payload: { path: ['email'], equals: email } } });

      await scheduler.remindAbandonedCarts();
      expect(await reminders()).toBe(0); // just touched: not abandoned

      // `updatedAt` is Prisma's own @updatedAt column, so backdating it takes raw SQL.
      await db.$executeRawUnsafe(`UPDATE carts SET "updatedAt" = now() - interval '2 hours' WHERE "ownerKey" = $1`, ownerKey);
      await scheduler.remindAbandonedCarts();
      expect(await reminders()).toBe(1);

      await scheduler.remindAbandonedCarts();
      expect(await reminders()).toBe(1); // the same untouched cart is not reminded twice
    } finally {
      await db.cart.deleteMany({ where: { ownerKey } });
      await db.outboxEvent.deleteMany({ where: { routingKey: 'cart.abandoned', payload: { path: ['email'], equals: email } } });
      await db.user.delete({ where: { id: user.id } });
    }
  });
});
