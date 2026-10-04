import type { Session } from '@ecom/contracts';
import type { Request, Response } from 'express';
import type { SignedIn } from '../auth/auth-service';
import type { Services } from '../container';
import { mustUser, optionalAuth, requireAuth, csrf } from '../http/auth';
import { clearRefreshCookie, readGuestCartToken, readRefreshCookie, setRefreshCookie } from '../http/cookies';
import type { Routes } from '../http/route';
import { str } from '../http/validate';

/** Response body of every sign-in style endpoint. The refresh token only ever travels as an HttpOnly cookie. */
interface SignInResponse {
  session: Session;
  accessToken: string;
}

/** Strict limit on the endpoints worth brute-forcing; the global limit covers the rest. */
const STRICT = { limit: 10 };

export function authRoutes(r: Routes, s: Services): void {
  const { config } = s;
  const secure = config.production;

  const respond = (res: Response, signedIn: SignedIn): SignInResponse => {
    setRefreshCookie(res, signedIn.refresh.token, signedIn.refresh.expiresAt, secure);
    return { session: signedIn.session, accessToken: signedIn.accessToken };
  };

  /** Whatever was in the guest cart (identified by the `gcid` cookie, if any) moves into the now-signed-in user's own cart. */
  const mergeGuestCart = async (req: Request, signedIn: SignedIn): Promise<void> => {
    const guestToken = readGuestCartToken(req);
    if (guestToken) await s.cart.mergeGuestIntoUser(`guest:${guestToken}`, signedIn.session.user.id);
  };

  r.post('/auth/register', { strict: STRICT, body: { name: str(200), email: str(320), password: str(200) } }, async (req, res) => {
    const signedIn = await s.auth.register(req.body);
    await mergeGuestCart(req, signedIn);
    return respond(res, signedIn);
  });

  r.post('/auth/login', { status: 200, strict: STRICT, body: { email: str(320), password: str(200) } }, async (req, res) => {
    const signedIn = await s.auth.login(req.body.email, req.body.password);
    await mergeGuestCart(req, signedIn);
    return respond(res, signedIn);
  });

  r.post('/auth/refresh', { status: 200, guards: [csrf] }, async (req, res) => {
    try {
      return respond(res, await s.auth.refresh(readRefreshCookie(req)));
    } catch (error) {
      clearRefreshCookie(res, secure);
      throw error;
    }
  });

  r.post('/auth/logout', { status: 204, guards: [csrf] }, async (req, res) => {
    await s.auth.logout(readRefreshCookie(req));
    clearRefreshCookie(res, secure);
  });

  r.get('/auth/me', { guards: [requireAuth(config)] }, (req) => s.auth.session(mustUser(req).id));

  r.post('/auth/verify-email', { status: 204, strict: STRICT, body: { token: str(200) } }, (req) => s.auth.verifyEmail(req.body.token));

  r.post('/auth/password-reset/request', { status: 204, strict: STRICT, body: { email: str(320) } }, (req) => s.auth.requestPasswordReset(req.body.email));

  r.post('/auth/password-reset', { status: 204, strict: STRICT, body: { token: str(200), password: str(200) } }, (req) => s.auth.resetPassword(req.body.token, req.body.password));
}

// `optionalAuth` is re-exported for the other route modules.
export { optionalAuth };
