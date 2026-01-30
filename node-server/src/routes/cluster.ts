/**
 * Cluster Management API Routes
 *
 * Endpoints for server registration and cluster management.
 */

import { Router, Request, Response } from 'express';
import { serverRegistry } from '../cluster/server-registry';

const router = Router();

/**
 * GET /api/servers
 * List all servers in the cluster (local + registered peers)
 */
router.get('/servers', (_req: Request, res: Response) => {
  const clusterInfo = serverRegistry.getClusterInfo();
  res.json(clusterInfo);
});

/**
 * POST /api/servers/register
 * Register a peer server with this server
 */
router.post('/servers/register', (req: Request, res: Response) => {
  const { host, port, name, secret } = req.body;

  if (!host || !port) {
    res.status(400).json({ error: 'host and port are required' });
    return;
  }

  const result = serverRegistry.register({ host, port, name, secret });

  if (!result.success) {
    res.status(403).json({ error: result.error });
    return;
  }

  res.json({
    registered: true,
    serverId: result.serverId,
  });
});

/**
 * DELETE /api/servers/:serverId
 * Unregister a peer server
 */
router.delete('/servers/:serverId', (req: Request, res: Response) => {
  const { serverId } = req.params;
  const { secret } = req.body;

  // Validate secret if configured
  const clusterSecret = process.env.NEBULA_CLUSTER_SECRET;
  if (clusterSecret && secret !== clusterSecret) {
    res.status(403).json({ error: 'Invalid cluster secret' });
    return;
  }

  const removed = serverRegistry.unregister(serverId);

  if (!removed) {
    res.status(404).json({ error: 'Server not found' });
    return;
  }

  res.json({ unregistered: true });
});

/**
 * POST /api/servers/:serverId/heartbeat
 * Record heartbeat from a peer server
 */
router.post('/servers/:serverId/heartbeat', (req: Request, res: Response) => {
  const { serverId } = req.params;

  const success = serverRegistry.heartbeat(serverId);

  if (!success) {
    res.status(404).json({ error: 'Server not found' });
    return;
  }

  res.json({ ok: true });
});

/**
 * GET /api/servers/:serverId
 * Get info about a specific server
 */
router.get('/servers/:serverId', (req: Request, res: Response) => {
  const { serverId } = req.params;

  const server = serverRegistry.getServer(serverId);

  if (!server) {
    res.status(404).json({ error: 'Server not found' });
    return;
  }

  res.json({
    id: server.id,
    name: server.name,
    url: server.url,
    status: server.status,
    registeredAt: server.registeredAt,
    lastHeartbeat: server.lastHeartbeat,
  });
});

export default router;
