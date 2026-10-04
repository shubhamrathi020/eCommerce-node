// Prisma 7 config, used only to generate the client from prisma/schema.prisma. This repository never migrates
// the database: the schema is owned by eCommerce-api (NestJS), whose migrations create the tables used here.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env['DATABASE_URL'] ?? 'postgresql://unused' },
});
