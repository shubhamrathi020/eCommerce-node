import { createHash } from 'node:crypto';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { RateLimitGuard } from '../cache/rate-limit';
import type { ApiConfig } from '../config';
import { type AuthedRequest } from './auth';
import { Throttler } from './throttle';
import { type Shape, validateBody } from './validate';

export type Handler = (req: AuthedRequest, res: Response) => unknown;

export interface RouteOptions {
  /** Success status (Nest's default: 201 for POST, otherwise 200). */
  status?: number;
  /** A stricter per-route limit than the blanket one (the auth endpoints). */
  strict?: { limit: number };
  /** Health probes are never rate limited. */
  skipThrottle?: boolean;
  /** One of the configured Redis-backed buckets (search, coupon, checkout). */
  bucket?: keyof ApiConfig['rateLimits'];
  /** Guards, in order (authentication, CSRF, ownership ...). */
  guards?: RequestHandler[];
  /** The request body must match this shape (whitelist + forbid unknown properties). */
  body?: Shape;
  /** Publicly cacheable for this many seconds: sets Cache-Control and an ETag and answers If-None-Match with 304. */
  cache?: number;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Registers routes in the order a Nest request is processed: blanket rate limit, bucket rate limit, guards, body
 * validation, handler. Success responses follow Nest's rules (JSON for objects, text for strings, empty for nothing).
 */
export class Routes {
  constructor(
    private readonly app: Express,
    private readonly config: ApiConfig,
    private readonly throttler: Throttler,
    private readonly buckets: RateLimitGuard,
  ) {}

  private add(method: Method, path: string, options: RouteOptions, handler: Handler): void {
    const chain: RequestHandler[] = [];
    if (!options.skipThrottle) chain.push(this.throttler.limit(`${method.toUpperCase()} ${path}`, options.strict?.limit ?? this.config.rateLimits.global.limit));
    if (options.bucket) chain.push(this.buckets.guard(options.bucket));
    chain.push(...(options.guards ?? []));
    const shape = options.body;
    if (shape) {
      chain.push((req: Request, _res: Response, next: NextFunction) => {
        try {
          validateBody(shape, req.body);
          next();
        } catch (error) {
          next(error);
        }
      });
    }
    const status = options.status ?? (method === 'post' ? 201 : 200);
    chain.push((req: Request, res: Response, next: NextFunction) => {
      Promise.resolve()
        .then(() => handler(req as AuthedRequest, res))
        .then((result) => respond(req, res, status, result, options.cache))
        .catch(next);
    });
    this.app[method](path, ...chain);
  }

  get(path: string, options: RouteOptions, handler: Handler): void {
    this.add('get', path, options, handler);
  }
  post(path: string, options: RouteOptions, handler: Handler): void {
    this.add('post', path, options, handler);
  }
  put(path: string, options: RouteOptions, handler: Handler): void {
    this.add('put', path, options, handler);
  }
  patch(path: string, options: RouteOptions, handler: Handler): void {
    this.add('patch', path, options, handler);
  }
  delete(path: string, options: RouteOptions, handler: Handler): void {
    this.add('delete', path, options, handler);
  }
}

function respond(req: Request, res: Response, status: number, result: unknown, cacheMaxAge: number | undefined): void {
  if (res.headersSent) return;
  if (cacheMaxAge !== undefined) {
    const etag = `"${createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 27)}"`;
    res.setHeader('Cache-Control', `public, max-age=${cacheMaxAge}`);
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
  }
  if (result === undefined || result === null) res.status(status).send();
  else if (typeof result === 'string') res.status(status).send(result);
  else res.status(status).json(result);
}
