import type { ApiError, ApiErrorCode } from '@ecom/contracts';
import type { NextFunction, Request, Response } from 'express';
import { Logger } from '../logger';
import { AppError, HttpError } from './errors';

const CODE_FOR_STATUS: Record<number, ApiErrorCode> = { 400: 'validation', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'validation', 429: 'forbidden' };

const logger = new Logger('ApiError');

/**
 * Turns every error into the `ApiError` JSON shape the frontend already handles. Unexpected errors are
 * logged in full with the request id and returned as a generic message: no stack traces or internals leak.
 */
export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const requestId = String(req.headers['x-request-id'] ?? '');
  let status = 500;
  let body: ApiError;

  if (error instanceof AppError) {
    status = error.status;
    body = { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) };
  } else if (error instanceof HttpError) {
    status = error.status;
    const code = CODE_FOR_STATUS[status] ?? (status >= 500 ? 'unknown' : 'validation');
    const message = status === 429 ? 'Too many requests. Please wait a moment and try again.' : status === 404 ? 'Not found' : error.message;
    body = { code, message };
  } else if (error instanceof SyntaxError || error instanceof URIError) {
    // Malformed JSON from the body parser, or a path parameter with a broken percent-encoding.
    status = 400;
    body = { code: 'validation', message: error.message };
  } else {
    logger.error(JSON.stringify({ requestId, method: req.method, path: req.path, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }));
    body = { code: 'unknown', message: 'Something went wrong. Please try again.' };
  }
  res.status(status).json({ ...body, ...(requestId ? { requestId } : {}) });
}
