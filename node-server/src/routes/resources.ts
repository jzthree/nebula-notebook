/**
 * Resources API Routes
 *
 * Provides endpoints for system resource monitoring (RAM, GPU).
 */

import { Router, Request, Response } from 'express';
import { getResourceService } from '../resources/resource-service';
import { serverRegistry } from '../cluster/server-registry';

const router = Router();
const resourceService = getResourceService();

/**
 * GET /api/resources
 *
 * Get server resources (RAM, GPU).
 * If server_id is provided and not local, fetches from remote server.
 * Returns cached data - never blocks.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const serverId = req.query.server_id as string | undefined;
    const localServerId = serverRegistry.getLocalServerId();

    // Check if we need to fetch from a remote server
    if (serverId && serverId !== localServerId && serverId !== 'local') {
      const server = serverRegistry.getServer(serverId);
      if (!server) {
        res.status(404).json({ error: `Server not found: ${serverId}` });
        return;
      }
      if (server.status !== 'online') {
        res.status(503).json({ error: `Server is offline: ${serverId}` });
        return;
      }

      // Fetch from remote server
      const response = await fetch(`${server.url}/api/resources`, {
        headers: process.env.NEBULA_CLUSTER_SECRET
          ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET }
          : undefined,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        res.status(response.status).json({ error: error.error || 'Failed to fetch resources' });
        return;
      }
      const data = await response.json();
      res.json(data);
      return;
    }

    // Return local resources
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
