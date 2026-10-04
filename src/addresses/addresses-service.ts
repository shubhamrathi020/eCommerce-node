import type { SavedAddress } from '@ecom/contracts';
import type { Db, SavedAddressRow } from '../db/prisma';
import { AppError, assertNoFieldErrors } from '../http/errors';

const PHONE = /^[6-9][0-9]{9}$/;
const PINCODE = /^[1-9][0-9]{5}$/;
export const MAX_ADDRESSES = 10;

/** The validated body of an add/update address request. */
export interface AddressInput {
  label: string;
  name: string;
  phone: string;
  address: { line1: string; line2?: string | null; city: string; state: string; pincode: string };
}

export function toSavedAddress(row: SavedAddressRow): SavedAddress {
  return {
    id: row.id,
    label: row.label,
    name: row.name,
    phone: row.phone,
    address: { line1: row.line1, ...(row.line2 ? { line2: row.line2 } : {}), city: row.city, state: row.state, pincode: row.pincode },
    isDefault: row.isDefault,
  };
}

/** Same rules and messages as the mock address book the frontend was built against. */
function validate(input: AddressInput) {
  const fields: Record<string, string> = {};
  if (!input.label.trim() || input.label.trim().length > 30) fields['label'] = 'Give this address a short label';
  if (!input.name.trim()) fields['name'] = 'Name is required';
  if (!PHONE.test(input.phone)) fields['phone'] = 'Enter a valid 10-digit mobile number';
  if (!input.address.line1.trim()) fields['line1'] = 'Address is required';
  if (!input.address.city.trim()) fields['city'] = 'City is required';
  if (!input.address.state.trim()) fields['state'] = 'State is required';
  if (!PINCODE.test(input.address.pincode)) fields['pincode'] = 'Enter a valid 6-digit pin code';
  assertNoFieldErrors(fields);
  return {
    label: input.label.trim(),
    name: input.name.trim(),
    phone: input.phone,
    line1: input.address.line1.trim(),
    line2: input.address.line2?.trim() || null,
    city: input.address.city.trim(),
    state: input.address.state.trim(),
    pincode: input.address.pincode,
  };
}

export class AddressesService {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<SavedAddress[]> {
    return (await this.db.savedAddress.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } })).map(toSavedAddress);
  }

  async add(userId: string, input: AddressInput): Promise<SavedAddress[]> {
    const data = validate(input);
    const count = await this.db.savedAddress.count({ where: { userId } });
    if (count >= MAX_ADDRESSES) throw new AppError('validation', `You can save up to ${MAX_ADDRESSES} addresses.`);
    await this.db.savedAddress.create({ data: { ...data, userId, isDefault: count === 0 } });
    return this.list(userId);
  }

  async update(userId: string, id: string, input: AddressInput): Promise<SavedAddress[]> {
    const data = validate(input);
    // `userId` in every where clause: one customer can never touch another's address, even by guessing ids.
    const updated = await this.db.savedAddress.updateMany({ where: { id, userId }, data });
    if (updated.count === 0) throw new AppError('not_found', 'Address not found');
    return this.list(userId);
  }

  async remove(userId: string, id: string): Promise<SavedAddress[]> {
    await this.db.$transaction(async (tx) => {
      const removed = await tx.savedAddress.findFirst({ where: { id, userId } });
      if (!removed) return;
      await tx.savedAddress.delete({ where: { id } });
      // Removing the default promotes the oldest remaining address.
      if (removed.isDefault) {
        const next = await tx.savedAddress.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
        if (next) await tx.savedAddress.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });
    return this.list(userId);
  }

  async setDefault(userId: string, id: string): Promise<SavedAddress[]> {
    await this.db.$transaction(async (tx) => {
      if (!(await tx.savedAddress.findFirst({ where: { id, userId } }))) throw new AppError('not_found', 'Address not found');
      await tx.savedAddress.updateMany({ where: { userId }, data: { isDefault: false } });
      await tx.savedAddress.update({ where: { id }, data: { isDefault: true } });
    });
    return this.list(userId);
  }
}
