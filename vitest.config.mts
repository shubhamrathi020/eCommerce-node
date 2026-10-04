import { defineConfig } from 'vitest/config';

// Unit tests only. The integration specs live in eCommerce-api and are run against this server (see README.md).
export default defineConfig({
  test: { globals: true, environment: 'node', include: ['src/**/*.spec.ts'], testTimeout: 20_000 },
});
