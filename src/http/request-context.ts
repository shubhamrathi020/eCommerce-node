import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from '../logger';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;
const logger = new Logger('HTTP');

/**
 * Correlation id and structured access log. A caller-supplied `x-request-id` is reused only when it looks like an id
 * (so a client cannot inject arbitrary text into our logs); otherwise a fresh one is made. Every log line is JSON with
 * that id. No bodies, headers or query strings are logged: they can carry PII.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('x-request-id', id);
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    logger.log(JSON.stringify({ requestId: id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms * 10) / 10 }));
  });
  next();
}
