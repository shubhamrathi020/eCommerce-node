import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ApiConfig } from '../config';
import { HttpError } from '../http/errors';
import type { CacheService } from './cache';
import type { RedisService } from './redis';

/**
 * A plain fixed-window counter (`INCR` + `EXPIRE`), per client IP, per bucket, per window:
 * `ratelimit:<bucket>:<window-start>:<ip>`, so old windows expire and are never cleaned up by hand. The limits are
 * read from the configuration at request time. Fails open on a Redis outage (a rate limiter that takes the site down
 * on a cache blip is worse than a brief lapse in limiting).
 */
export class RateLimitGuard {
  constructor(
    private readonly config: ApiConfig,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
  ) {}

  guard(bucket: keyof ApiConfig['rateLimits']): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      this.check(bucket, req, res).then(
        () => next(),
        (error) => next(error),
      );
    };
  }

  private async check(bucket: keyof ApiConfig['rateLimits'], req: Request, res: Response): Promise<void> {
    if (!this.config.rateLimit) return;
    const { limit, windowSeconds } = this.config.rateLimits[bucket];
    const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
    const key = `ratelimit:${bucket}:${windowStart}:${req.ip}`;
    let count: number;
    try {
      count = await this.redis.raw.incr(key);
      if (count === 1) await this.redis.raw.expire(key, windowSeconds);
    } catch {
      return; // Redis unavailable: fail open rather than block all traffic on a cache outage.
    }
    if (count > limit) {
      this.cache.recordRateLimitBlocked(bucket);
      res.setHeader('Retry-After', String(windowStart + windowSeconds - Math.floor(Date.now() / 1000)));
      throw new HttpError(429, 'Too many requests. Please wait a moment and try again.');
    }
  }
}
