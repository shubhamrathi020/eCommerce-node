import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express } from 'express';
import { getAbsoluteFSPath } from 'swagger-ui-dist';

/**
 * The API documentation page, served exactly where the Nest API serves it: /docs (Swagger UI), /docs/openapi.json and the UI's own
 * assets. The pages, the initialiser and the document are the files `eCommerce-api` exports (test/export-openapi.spec.ts) into `docs/`.
 */
export function registerDocs(app: Express): void {
  const dir = join(__dirname, '..', '..', 'docs');
  const index = readFileSync(join(dir, 'index.html'), 'utf8');
  const indexSlash = readFileSync(join(dir, 'index-slash.html'), 'utf8');
  const init = readFileSync(join(dir, 'swagger-ui-init.js'), 'utf8');
  const document: unknown = JSON.parse(readFileSync(join(dir, 'openapi.json'), 'utf8'));
  // Nest serves two slightly different pages (the one under /docs/ links its assets relative to that folder).
  const router = express.Router({ strict: true }); // so that /docs and /docs/ can answer differently
  router.get('/docs', (_req, res) => {
    res.type('html').send(index);
  });
  router.get('/docs/', (_req, res) => {
    res.type('html').send(indexSlash);
  });
  router.get('/docs/swagger-ui-init.js', (_req, res) => {
    res.type('application/javascript').send(init);
  });
  router.get('/docs/openapi.json', (_req, res) => {
    res.json(document);
  });
  app.use(router);
  app.use('/docs', express.static(getAbsoluteFSPath(), { index: false }));
}
