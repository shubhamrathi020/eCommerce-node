import { type Collection, MongoClient } from 'mongodb';
import type { ApiConfig } from '../config';
import type { BrandDoc, CategoryDoc, CollectionDoc, HomeDoc, ProductDoc, ReviewDoc } from './catalog.types';

/**
 * The catalog store (BRD 20, CS-01): MongoDB, chosen over Postgres for products because attributes and
 * variant options differ freely by category (steering/architecture.md's decision, confirmed BRD 19 F4).
 * A native driver is used directly rather than Prisma's Mongo connector, to keep Prisma scoped to the
 * one thing it is doing well here (Postgres migrations) and avoid mixing two very different Prisma
 * mental models (SQL migrations vs. schemaless) in one codebase.
 */
export class MongoService {
  private client!: MongoClient;

  constructor(private readonly config: ApiConfig) {}

  async init(): Promise<void> {
    this.client = new MongoClient(this.config.mongoUrl);
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client?.close();
  }

  async ping(): Promise<void> {
    await this.client.db(this.config.mongoDbName).command({ ping: 1 });
  }

  private db() {
    return this.client.db(this.config.mongoDbName);
  }

  get products(): Collection<ProductDoc> {
    return this.db().collection<ProductDoc>('products');
  }

  get categories(): Collection<CategoryDoc> {
    return this.db().collection<CategoryDoc>('categories');
  }

  get brands(): Collection<BrandDoc> {
    return this.db().collection<BrandDoc>('brands');
  }

  get collections(): Collection<CollectionDoc> {
    return this.db().collection<CollectionDoc>('collections');
  }

  get reviews(): Collection<ReviewDoc> {
    return this.db().collection<ReviewDoc>('reviews');
  }

  get home(): Collection<HomeDoc> {
    return this.db().collection<HomeDoc>('home');
  }
}
