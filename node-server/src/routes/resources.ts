/**
 * Resources API Routes
 *
 * Provides endpoints for system resource monitoring (RAM, GPU).
 */

import { Router, Request, Response } from 'express';
import { getResourceService } from '../resources/resource-service';

const router = Router();
const resourceService = getResourceService();

/**
 * GET /api/resources
 *
 * Get current server's resources (RAM, GPU).
 * Returns cached data - never blocks.
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const resources = resourceService.getResources();
    res.json({
      ...resources,
      isStale: resourceService.isStale(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * POST /api/resources/refresh
 *
 * Force refresh resources (still has timeout protection).
 * Use sparingly - normally cached data is sufficient.
 */
router.post('/refresh', async (_req: Request, res: Response) => {
  try {
    const resources = await resourceService.refreshResources();
    res.json({
      ...resources,
      isStale: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export default router;
