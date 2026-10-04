import { PrismaPg } from '@prisma/adapter-pg';
// The generated client is gitignored; this import keeps its runtime helper in the production dependency set.
import '@prisma/client-runtime-utils';
import { PrismaClient } from '../../generated/prisma';

export type { Prisma } from '../../generated/prisma';
export type { Order as OrderRow, SavedAddress as SavedAddressRow, User as UserRow } from '../../generated/prisma';

/** The one database client for the app (Prisma 7 connects through a driver adapter). */
export class Db extends PrismaClient {
  constructor(databaseUrl: string) {
    super({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }
}
