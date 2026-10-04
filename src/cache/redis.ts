import Redis from 'ioredis';
import type { ApiConfig } from '../config';

/** The one Redis connection the API uses for caching, rate limits, locks and live order updates. */
export class RedisService {
  private client!: Redis;

  constructor(private readonly config: ApiConfig) {}

  async init(): Promise<void> {
    // `keyPrefix` namespaces every key this app touches, so a test run (a different prefix, see config.ts) can never
    // collide with development data in the same Redis.
    this.client = new Redis(this.config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2, keyPrefix: this.config.redisKeyPrefix });
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }

  get raw(): Redis {
    return this.client;
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }
}
