import type { Order } from '@ecom/contracts';
import type { RedisService } from '../cache/redis';
import type { ApiConfig } from '../config';

/**
 * Real-time order tracking: Redis pub/sub, not RabbitMQ. This is a live, best-effort push to whatever browser tab is open
 * on the order-tracking page right now, not a durable event that must survive a broker restart (that is what the
 * outbox and RabbitMQ pipeline are for). A tab that is not connected when a status change happens simply sees the new
 * status on its next `GET /orders/:id`.
 */
export class OrderEventsService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfig,
  ) {}

  private channel(orderId: string): string {
    return `${this.config.redisKeyPrefix}order-events:${orderId}`;
  }

  async publish(order: Order): Promise<void> {
    await this.redis.raw.publish(this.channel(order.id), JSON.stringify(order));
  }

  /**
   * Calls `send` with `initial` immediately (the order's current state) and then with every later change. Returns the
   * function that ends the subscription. `onError` is called if the subscription cannot be established.
   */
  observe(orderId: string, initial: Order, send: (order: unknown) => void, onError: (error: unknown) => void): () => void {
    send(initial);
    const sub = this.redis.raw.duplicate();
    const channel = this.channel(orderId);
    const onMessage = (ch: string, message: string) => {
      if (ch === channel) send(JSON.parse(message));
    };
    sub.on('message', onMessage);
    sub.on('error', () => undefined);
    sub.subscribe(channel).catch(onError);
    return () => {
      sub.removeListener('message', onMessage);
      sub.unsubscribe(channel).catch(() => undefined);
      sub.quit().catch(() => undefined);
    };
  }
}
