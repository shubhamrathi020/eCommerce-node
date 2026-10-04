import type { Services } from '../container';
import { mustUser, requireAuth } from '../http/auth';
import { clearRefreshCookie, readRefreshCookie } from '../http/cookies';
import type { Routes } from '../http/route';
import { nested, optional, str } from '../http/validate';

export function accountRoutes(r: Routes, s: Services): void {
  const { config } = s;

  r.patch('/account/profile', { guards: [requireAuth(config, 'profile:write:own')], body: { name: str(200), phone: optional(str(20)) } }, (req) => s.accounts.updateProfile(mustUser(req).id, req.body));

  /** Under `/auth` so the browser sends the refresh cookie, which identifies the device to keep signed in. */
  r.post('/auth/change-password', { status: 204, guards: [requireAuth(config, 'profile:write:own')], body: { currentPassword: str(200), newPassword: str(200) } }, async (req) => {
    await s.accounts.changePassword(mustUser(req).id, req.body.currentPassword, req.body.newPassword, readRefreshCookie(req));
  });

  r.get('/account/export', { guards: [requireAuth(config)] }, (req) => s.accounts.exportData(mustUser(req).id));

  r.post('/account/delete', { status: 204, guards: [requireAuth(config, 'profile:write:own')], body: { password: str(200) } }, async (req, res) => {
    await s.accounts.deleteAccount(mustUser(req).id, req.body.password);
    clearRefreshCookie(res, config.production);
  });

  const guard = requireAuth(config, 'address:write:own');
  const address = nested({ line1: str(200), line2: optional(str(200)), city: str(100), state: str(100), pincode: str(10) });
  const input = { label: str(60), name: str(120), phone: str(20), address };

  r.get('/account/addresses', { guards: [guard] }, (req) => s.addresses.list(mustUser(req).id));
  r.post('/account/addresses', { guards: [guard], body: input }, (req) => s.addresses.add(mustUser(req).id, req.body));
  r.put('/account/addresses/:id', { guards: [guard], body: input }, (req) => s.addresses.update(mustUser(req).id, req.params['id'], req.body));
  r.delete('/account/addresses/:id', { guards: [guard] }, (req) => s.addresses.remove(mustUser(req).id, req.params['id']));
  r.post('/account/addresses/:id/default', { status: 200, guards: [guard] }, (req) => s.addresses.setDefault(mustUser(req).id, req.params['id']));
}
