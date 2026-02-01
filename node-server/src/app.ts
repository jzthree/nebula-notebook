/**
 * Express App Setup - Shared middleware and configuration
 */

import express, { Express, Request, Response } from 'express';
import cors from 'cors';

export function createApp(): Express {
  const app = express();

  // Shared middleware
  app.use(cors());
  const bodyLimit =
    process.env.NEBULA_BODY_LIMIT ||
    process.env.NEBULA_MAX_BODY_SIZE ||
    '200mb';
  app.use(express.json({ limit: bodyLimit }));
  app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

  // Health check endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'nebula-node-server',
      timestamp: new Date().toISOString()
    });
  });

  return app;
}
