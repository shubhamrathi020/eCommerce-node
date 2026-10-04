import type { Role } from '@ecom/contracts';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { ApiConfig } from '../config';
import { AppError } from './errors';

/** What an authenticated request knows about its caller (from the short-lived access token). */
export interface AuthUser {
  id: string;
  roles: Role[];
  permissions: string[];
}

export interface AccessTokenPayload {
  sub: string;
  roles: Role[];
  permissions: string[];
}

export type AuthedRequest = Request & { user?: AuthUser; rawBody?: string };

const bearer = (req: Request): string => {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
};

function verify(config: ApiConfig, token: string): AccessTokenPayload {
  return jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'], audience: 'ecom-api', issuer: 'ecom-api' }) as unknown as AccessTokenPayload;
}

/**
 * Bearer access-token check plus permission enforcement; every listed permission is required. The browser-side guards
 * are only a convenience, this is the real boundary.
 */
export function requireAuth(config: ApiConfig, ...required: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (!token) return next(new AppError('unauthorized', 'Please sign in.'));
    let payload: AccessTokenPayload;
    try {
      payload = verify(config, token);
    } catch {
      return next(new AppError('unauthorized', 'Your session has expired. Please sign in again.'));
    }
    (req as AuthedRequest).user = { id: payload.sub, roles: payload.roles, permissions: payload.permissions };
    if (required.some((p) => !payload.permissions.includes(p))) return next(new AppError('forbidden', 'You do not have permission to do that.'));
    next();
  };
}

/**
 * For routes usable both signed in and as a guest (cart, checkout, orders). Decodes a bearer token when one is present
 * and valid, setting `req.user`; never refuses the request either way.
 */
export function optionalAuth(config: ApiConfig): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = bearer(req);
    if (token) {
      try {
        const payload = verify(config, token);
        (req as AuthedRequest).user = { id: payload.sub, roles: payload.roles, permissions: payload.permissions };
      } catch {
        // An expired or invalid token on an optional-auth route is treated the same as no token: still a guest.
      }
    }
    next();
  };
}

/**
 * CSRF protection for the endpoints that act on a cookie. The cookie is `SameSite=Lax`, and these endpoints additionally
 * require a custom header: a cross-site page cannot send one without a CORS preflight, which only our own origins pass.
 */
export const csrf: RequestHandler = (req, _res, next) => {
  if (req.headers['x-csrf'] !== '1') return next(new AppError('forbidden', 'Missing CSRF header.'));
  next();
};

export function mustUser(req: Request): AuthUser {
  const user = (req as AuthedRequest).user;
  if (!user) throw new AppError('unauthorized', 'Please sign in.');
  return user;
}

export const userOf = (req: Request): AuthUser | undefined => (req as AuthedRequest).user;
