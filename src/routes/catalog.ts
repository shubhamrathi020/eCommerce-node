import type { AdminProductQuery, ListingQuery, ProductStatus, ReviewSort, SearchSuggestions, SortKey } from '@ecom/contracts';
import type { Services } from '../container';
import { requireAuth } from '../http/auth';
import { AppError } from '../http/errors';
import type { Routes } from '../http/route';
import { anyArray, anyObject, arrayOf, int as intField, num, oneOf, optional, str } from '../http/validate';

const SORT_KEYS: SortKey[] = ['relevance', 'featured', 'price-asc', 'price-desc', 'newest', 'rating', 'discount'];
const REVIEW_SORTS: ReviewSort[] = ['recent', 'helpful', 'high', 'low'];
const STATUSES: ProductStatus[] = ['draft', 'published', 'archived'];
const POPULAR_SEARCHES = ['smartphone', 'sneakers', 't-shirt', 'laptop', 'headphones', 'yoga mat', 'air fryer', 'watch'];
const MAX_QUERY_LENGTH = 100;

type Query = Record<string, string>;

/** Parses `filters` as a JSON object of string arrays (the shape `ListingQuery.filters` needs); anything else
 * (missing, malformed, wrong types) is treated as "no filters" rather than a 500. */
function parseFilters(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'string' || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
    return out;
  } catch {
    return {};
  }
}

const int = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

const idsOf = (body: unknown): string[] => {
  const ids = (body as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
};

export function catalogRoutes(r: Routes, s: Services): void {
  r.get('/catalog/home', { cache: 60 }, () => s.catalog.home());

  r.get('/catalog/categories/tree', { cache: 300 }, () => s.catalog.categoryTree());

  r.get('/catalog/listing', { cache: 30 }, (req) => {
    const q = req.query as Query;
    const sort = SORT_KEYS.includes(q['sort'] as SortKey) ? (q['sort'] as SortKey) : 'relevance';
    const query: ListingQuery = {
      ...(q['categorySlug'] ? { categorySlug: q['categorySlug'] } : {}),
      ...(q['brandSlug'] ? { brandSlug: q['brandSlug'] } : {}),
      ...(q['collectionSlug'] ? { collectionSlug: q['collectionSlug'] } : {}),
      ...(q['q'] ? { q: q['q'] } : {}),
      filters: parseFilters(q['filters']),
      ...(q['priceMin'] !== undefined ? { priceMin: int(q['priceMin'], 0) } : {}),
      ...(q['priceMax'] !== undefined ? { priceMax: int(q['priceMax'], 0) } : {}),
      sort,
      page: int(q['page'], 1),
      pageSize: Math.min(100, int(q['pageSize'], 24)),
    };
    return s.catalog.listing(query);
  });

  r.get('/catalog/products/:slug', { cache: 120 }, (req) => s.catalog.product(req.params['slug']));
  r.post('/catalog/products/by-ids', {}, (req) => s.catalog.productsByIds(idsOf(req.body)));
  r.post('/catalog/products/summaries', {}, (req) => s.catalog.summariesByIds(idsOf(req.body)));
  r.get('/catalog/products/:id/related', {}, (req) => s.catalog.related(req.params['id']));
  r.get('/catalog/products/:id/bought-together', {}, (req) => s.catalog.boughtTogether(req.params['id']));

  r.get('/catalog/products/:id/reviews', {}, (req) => {
    const q = req.query as Query;
    const sort = REVIEW_SORTS.includes(q['sort'] as ReviewSort) ? (q['sort'] as ReviewSort) : 'recent';
    return s.catalog.reviews(req.params['id'], { sort, page: int(q['page'], 1), pageSize: Math.min(50, int(q['pageSize'], 10)) });
  });

  r.get('/catalog/serviceability/:pincode', {}, (req) => {
    const pincode = req.params['pincode'];
    if (!pincode) throw new AppError('validation', 'Enter a valid 6-digit pin code', { pincode: 'Invalid pin code' });
    return s.catalog.serviceability(pincode);
  });

  // Search suggestions beyond the results list; results themselves come from `GET /catalog/listing`.
  r.get('/search/suggest', { bucket: 'search' }, async (req): Promise<SearchSuggestions> => {
    const rawQ = req.query['q'] as string | undefined;
    const q = (rawQ ?? '').slice(0, MAX_QUERY_LENGTH).trim(); // a repeated ?q=a&q=b is an array here and fails, as in the Nest API
    if (!q) return { queries: POPULAR_SEARCHES.slice(0, 5), products: [], categories: [], brands: [] };
    // Product suggestions need Meilisearch; category and brand suggestions are plain Mongo reads. A search outage
    // should not also take those down: it degrades to an empty product list rather than failing the dropdown.
    const [idsResult, categories, brands] = await Promise.all([
      s.search.suggestProducts(q, 4).catch(() => [] as string[]),
      s.mongo.categories.find({ name: { $regex: q, $options: 'i' } }).limit(3).toArray(),
      s.mongo.brands.find({ name: { $regex: q, $options: 'i' } }).limit(3).toArray(),
    ]);
    const products = await s.catalog.summariesByIds(idsResult);
    const popularMatches = POPULAR_SEARCHES.filter((p) => p.toLowerCase().startsWith(q.toLowerCase()));
    return {
      queries: [...new Set([...popularMatches, ...categories.map((c) => c.name), ...brands.map((b) => b.name)])].slice(0, 5),
      products,
      categories: categories.map((c) => ({ slug: c.slug, name: c.name })),
      brands: brands.map((b) => ({ slug: b.slug, name: b.name })),
    };
  });

  r.get('/search/popular', {}, () => [...POPULAR_SEARCHES]);

  // Back-office product management.
  const read = requireAuth(s.config, 'product:read');
  const write = requireAuth(s.config, 'product:write');
  const variant = { id: optional(str()), sku: str(), options: anyObject(), price: num(0), mrp: optional(num(0)), stock: intField(0) };
  // No minimum array size on purpose: "add at least one variant" is the service's own field-level error.
  const product = { title: str(), brandName: str(), categoryId: str(), description: str(), highlights: anyArray(), tags: anyArray(), status: oneOf(...STATUSES), variants: arrayOf(variant) };

  r.get('/admin/products', { guards: [read] }, (req) => {
    const q = req.query as Query;
    const sort = (['updated', 'title', 'price', 'stock'] as const).includes(q['sort'] as never) ? (q['sort'] as AdminProductQuery['sort']) : 'updated';
    const query: AdminProductQuery = {
      ...(q['q'] ? { q: q['q'] } : {}),
      ...(q['status'] && STATUSES.includes(q['status'] as ProductStatus) ? { status: q['status'] as ProductStatus } : {}),
      sort,
      dir: q['dir'] === 'asc' ? 'asc' : 'desc',
      page: int(q['page'], 1),
      pageSize: Math.min(200, int(q['pageSize'], 20)),
    };
    return s.adminCatalog.list(query);
  });
  r.get('/admin/products/categories', { guards: [read] }, () => s.adminCatalog.categories());
  r.get('/admin/products/:id', { guards: [read] }, (req) => s.adminCatalog.get(req.params['id']));
  r.post('/admin/products', { guards: [write], body: product }, (req) => s.adminCatalog.create(req.body));
  r.put('/admin/products/:id', { guards: [write], body: product }, (req) => s.adminCatalog.update(req.params['id'], req.body));
  r.patch('/admin/products/bulk-status', { guards: [write], body: { ids: anyArray(), status: oneOf(...STATUSES) } }, (req) => s.adminCatalog.bulkSetStatus(req.body.ids, req.body.status).then((count) => ({ count })));
  r.patch('/admin/products/bulk-delete-drafts', { guards: [write], body: { ids: anyArray() } }, (req) => s.adminCatalog.bulkDeleteDrafts(req.body.ids).then((count) => ({ count })));
}
