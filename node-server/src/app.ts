/**
 * Express App Setup - Shared middleware and configuration
 */

import express, { Express, Request, Response } from 'express';
import cors from 'cors';

export function createApp(): Express {
  const app = express();

  // Shared middleware
  app.use(cors());
  app.use(express.json());

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
