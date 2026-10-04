import type { Services } from '../container';
import { requireAuth } from '../http/auth';
import { HttpError } from '../http/errors';
import type { Routes } from '../http/route';

export function systemRoutes(r: Routes, s: Services): void {
  const { config } = s;

  /** The process is up. Never touches dependencies, so an outage does not restart every pod. */
  r.get('/healthz', { skipThrottle: true }, () => 'ok');

  /** Ready for traffic only when every store the API depends on answers. */
  r.get('/readyz', { skipThrottle: true }, async () => {
    try {
      await Promise.all([s.db.$queryRaw`SELECT 1`, s.mongo.ping(), s.search.health(), s.redis.ping(), s.rabbit.ping()]);
      return 'ok';
    } catch {
      throw new HttpError(503, 'a dependency is unavailable');
    }
  });

  /** Development only: the mails the API would have sent (verification and reset links). 404 outside development. */
  r.get('/dev/outbox', { skipThrottle: true }, () => {
    if (config.production) throw new HttpError(404, 'Not found');
    return s.mail.list();
  });

  /** Prometheus scrapes this: internal and unauthenticated, kept off the public internet at the network layer. */
  r.get('/metrics', {}, async (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return s.metrics.render();
  });

  const read = requireAuth(config, 'system:read');

  r.get('/admin/system/cache-stats', { guards: [read] }, () => {
    const stats = s.cache.getStats();
    const total = stats.hits + stats.misses;
    return { ...stats, hitRatio: total === 0 ? 0 : Math.round((stats.hits / total) * 100) / 100 };
  });

  /** Circuit-breaker state for the two external dependencies: "closed" is normal, "open" means calls fail fast. */
  r.get('/admin/system/resilience', { guards: [read] }, () => ({ circuitBreakers: [s.razorpay.breakerStats(), s.search.breakerStats()] }));

  r.get('/admin/system/dead-letters', { guards: [read] }, (req) => s.rabbit.peek(s.rabbit.dlq, Math.min(100, Number(req.query['limit']) || 20)));

  r.post('/admin/system/dead-letters/replay', { status: 200, guards: [requireAuth(config, 'system:write')] }, async () => {
    const popped = await s.rabbit.popOldest(s.rabbit.dlq);
    if (!popped) return { replayed: false };
    await s.rabbit.publish(popped.routingKey, popped.body);
    return { replayed: true, routingKey: popped.routingKey };
  });
}
