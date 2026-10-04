import type { Server } from 'node:http';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import type { ApiConfig } from './config';
import { type Services, buildServices } from './container';
import { errorHandler } from './http/error-handler';
import { HttpError } from './http/errors';
import { requestContext } from './http/request-context';
import { Routes } from './http/route';
import { Logger } from './logger';
import { accountRoutes } from './routes/accounts';
import { authRoutes } from './routes/auth';
import { catalogRoutes } from './routes/catalog';
import { commerceRoutes } from './routes/commerce';
import { systemRoutes } from './routes/system';

const logger = new Logger('Bootstrap');

export interface RunningApp {
  express: Express;
  services: Services;
  /** Connects to every data store, starts the background jobs and begins listening. */
  listen(): Promise<Server>;
  /** Stops the jobs, closes the server and every connection. */
  close(): Promise<void>;
}

/**
 * Builds the Express app with the same pipeline as the Nest API's `configureApp` (security headers, cookies, CORS,
 * body limit with the raw body kept for the Razorpay webhook), then the request id/access log and the metrics timer,
 * the routes, and the error handler that renders every failure in the frontend's `ApiError` shape.
 */
export function createApp(config: ApiConfig): RunningApp {
  const services = buildServices(config);
  const app = express();
  app.disable('x-powered-by');
  // Behind Docker or an ingress: trust one proxy hop for the client IP (rate limiting uses it).
  app.set('trust proxy', 1);

  // A JSON API needs no content security policy beyond "nothing".
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
  app.use(cookieParser());
  // Credentials only for the listed origins. Anything else gets no CORS headers at all.
  app.use(cors({ origin: config.corsOrigins, credentials: true, allowedHeaders: ['content-type', 'authorization', 'x-csrf', 'x-request-id'], exposedHeaders: ['x-request-id'], maxAge: 600 }));
  // `verify` stashes the exact raw bytes on the request: the Razorpay webhook checks its signature against the untouched
  // body, not a re-serialised copy of the parsed JSON.
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => ((req as Request & { rawBody?: string }).rawBody = buf.toString('utf8')) }));

  app.use(requestContext);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/metrics') return next(); // scraping /metrics is not itself a metric worth recording
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      // The matched path pattern (`/orders/:id`), never the raw URL: one time series per order id would grow forever.
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      services.metrics.recordHttpRequest(req.method, route, res.statusCode, Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  });

  const routes = new Routes(app, config, services.throttler, services.rateLimits);
  systemRoutes(routes, services);
  authRoutes(routes, services);
  accountRoutes(routes, services);
  catalogRoutes(routes, services);
  commerceRoutes(routes, services);

  app.use((_req: Request, _res: Response, next: NextFunction) => next(new HttpError(404, 'Not found')));
  app.use(errorHandler);

  let server: Server | undefined;

  return {
    express: app,
    services,
    async listen() {
      const s = services;
      // Connections first, then the jobs that use them (the broker topology must exist before anything publishes into it).
      await Promise.all([s.redis.init(), s.mongo.init(), s.rabbit.init()]);
      await s.consumer.start();
      s.relay.start();
      s.scheduler.start();
      server = await new Promise<Server>((resolve) => {
        const listening = app.listen(config.port, '0.0.0.0', () => resolve(listening));
      });
      logger.log(`API listening on port ${config.port}`);
      return server;
    },
    async close() {
      const s = services;
      s.relay.stop();
      s.scheduler.stop();
      s.throttler.stop();
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
      await s.rabbit.close();
      await s.mongo.close();
      await s.redis.close();
      await s.db.$disconnect();
    },
  };
}
