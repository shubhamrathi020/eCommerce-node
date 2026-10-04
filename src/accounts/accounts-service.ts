import type { AccountExport, User } from '@ecom/contracts';
import { passwordProblem } from '@ecom/contracts';
import { toSavedAddress } from '../addresses/addresses-service';
import type { PasswordService } from '../auth/password';
import type { TokenService } from '../auth/tokens';
import { toUser } from '../auth/user-mapper';
import type { Db } from '../db/prisma';
import { AppError, assertNoFieldErrors } from '../http/errors';

const PHONE = /^[6-9][0-9]{9}$/;

export class AccountsService {
  constructor(
    private readonly db: Db,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  private async user(userId: string) {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('unauthorized', 'Please sign in.');
    return user;
  }

  async updateProfile(userId: string, changes: { name: string; phone?: string | null }): Promise<User> {
    await this.user(userId);
    const fields: Record<string, string> = {};
    const name = changes.name.trim();
    if (!name) fields['name'] = 'Name is required';
    else if (name.length > 80) fields['name'] = 'Use 80 characters or fewer';
    if (changes.phone && !PHONE.test(changes.phone)) fields['phone'] = 'Enter a valid 10-digit mobile number';
    assertNoFieldErrors(fields);
    return toUser(await this.db.user.update({ where: { id: userId }, data: { name, phone: changes.phone || null } }));
  }

  /** Signs out every other device; the one making the change (identified by its refresh cookie) stays signed in. */
  async changePassword(userId: string, current: string, next: string, refreshToken: string | undefined): Promise<void> {
    const user = await this.user(userId);
    if (!(await this.passwords.verify(user.passwordHash, current))) throw new AppError('validation', 'Your current password is incorrect.', { currentPassword: 'Incorrect password' });
    const problem = passwordProblem(next);
    if (problem) throw new AppError('validation', problem, { newPassword: problem });
    await this.db.user.update({ where: { id: userId }, data: { passwordHash: await this.passwords.hash(next) } });
    await this.tokens.revokeAllForUser(userId, await this.tokens.familyOf(refreshToken));
  }

  async exportData(userId: string): Promise<AccountExport> {
    const user = await this.db.user.findUnique({ where: { id: userId }, include: { addresses: { orderBy: { createdAt: 'asc' } } } });
    if (!user) throw new AppError('unauthorized', 'Please sign in.');
    const { permissions: _p, ...profile } = toUser(user);
    // Orders still live in the frontend mock until BRD 21 moves them to this API.
    return { exportedAt: new Date().toISOString(), profile, addresses: user.addresses.map(toSavedAddress), orderIds: [] };
  }

  /** Deletes the account and everything that belongs only to it (addresses, sessions) in one step. */
  async deleteAccount(userId: string, password: string): Promise<void> {
    const user = await this.user(userId);
    if (!(await this.passwords.verify(user.passwordHash, password))) throw new AppError('validation', 'That password is not correct.', { password: 'Incorrect password' });
    await this.db.$transaction([this.db.loginAttempt.deleteMany({ where: { email: user.email } }), this.db.user.delete({ where: { id: userId } })]);
  }
}
