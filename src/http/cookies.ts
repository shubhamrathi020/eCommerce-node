import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

const cookieOf = (req: Request, name: string): string | undefined => {
  const value = (req.cookies as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value ? value : undefined;
};

export const REFRESH_COOKIE = 'rt';
/** Scoped to the auth routes, so the refresh token is never sent with ordinary API calls. */
const REFRESH_PATH = '/auth';

export function setRefreshCookie(res: Response, token: string, expiresAt: Date, secure: boolean): void {
  res.cookie(REFRESH_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: REFRESH_PATH, expires: expiresAt });
}

export function clearRefreshCookie(res: Response, secure: boolean): void {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: REFRESH_PATH });
}

export const readRefreshCookie = (req: Request): string | undefined => cookieOf(req, REFRESH_COOKIE);

/** Identifies an anonymous shopper's cart across requests; not a secret, just an opaque per-browser id. */
export const GUEST_CART_COOKIE = 'gcid';
const ONE_YEAR_MS = 365 * 86_400_000;

export const readGuestCartToken = (req: Request): string | undefined => cookieOf(req, GUEST_CART_COOKIE);

/** Returns the guest cart token, creating and setting a fresh cookie the first time one is needed. */
export function ensureGuestCartToken(req: Request, res: Response, secure: boolean): string {
  const existing = readGuestCartToken(req);
  if (existing) return existing;
  const token = randomBytes(16).toString('base64url');
  res.cookie(GUEST_CART_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: ONE_YEAR_MS });
  return token;
}

/** The Cart/Order row key for whoever is making this request: the signed-in user, otherwise the guest cart cookie. */
export const ownerKeyFor = (userId: string | undefined, guestToken: string): string => (userId ? `user:${userId}` : `guest:${guestToken}`);
