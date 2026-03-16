/**
 * Resources API Routes
 *
 * Provides endpoints for system resource monitoring (RAM, GPU).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getResourceService } from '../resources/resource-service';
import { serverRegistry } from '../cluster/server-registry';

const resourceService = getResourceService();

export default async function resourceRoutes(fastify: FastifyInstance) {
  /**
   * GET /
   *
   * Get server resources (RAM, GPU).
   * If server_id is provided and not local, fetches from remote server.
   * Returns cached data - never blocks.
   */
  fastify.get('/', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const serverId = (request.query as any).server_id as string | undefined;
      const localServerId = serverRegistry.getLocalServerId();

      // Check if we need to fetch from a remote server
      if (serverId && serverId !== localServerId && serverId !== 'local') {
        const server = serverRegistry.getServer(serverId);
        if (!server) {
          return reply.code(404).send({ error: `Server not found: ${serverId}` });
        }
        if (server.status !== 'online') {
          return reply.code(503).send({ error: `Server is offline: ${serverId}` });
        }

        // Fetch from remote server
        const response = await fetch(`${server.url}/api/resources`, {
          headers: process.env.NEBULA_CLUSTER_SECRET
            ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET }
            : undefined,
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
          return reply.code(response.status).send({ error: error.error || 'Failed to fetch resources' });
        }
        const data = await response.json();
        return reply.send(data);
      }

      // Return local resources
      const resources = resourceService.getResources();
      return reply.send({
        ...resources,
        isStale: resourceService.isStale(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: message });
    }
  });

  /**
   * POST /refresh
   *
   * Force refresh resources (still has timeout protection).
   * Use sparingly - normally cached data is sufficient.
   */
  fastify.post('/refresh', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const resources = await resourceService.refreshResources();
      return reply.send({
        ...resources,
        isStale: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ error: message });
    }
  });
}
