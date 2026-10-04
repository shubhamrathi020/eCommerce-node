import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { HttpError } from './errors';

interface Window {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window limiter per (route handler, client IP): the same behaviour as `@nestjs/throttler` in the Nest
 * API. The blanket limit applies to every route; the auth endpoints worth brute-forcing pass a stricter one.
 */
export class Throttler {
  private readonly windows = new Map<string, Window>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly enabled: boolean) {
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
    }, 60_000);
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  limit(handlerId: string, limit: number, ttlMs = 60_000): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!this.enabled) return next();
      const key = `${handlerId}|${req.ip}`;
      const now = Date.now();
      let w = this.windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + ttlMs };
        this.windows.set(key, w);
      }
      w.count++;
      if (w.count > limit) {
        res.setHeader('Retry-After', String(Math.ceil((w.resetAt - now) / 1000)));
        return next(new HttpError(429, 'Too many requests. Please wait a moment and try again.'));
      }
      next();
    };
  }
}
