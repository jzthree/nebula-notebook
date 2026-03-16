/**
 * Cluster Management API Routes
 *
 * Endpoints for server registration and cluster management.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { serverRegistry } from '../cluster/server-registry';
import { getResourceService } from '../resources/resource-service';

const resourceService = getResourceService();

export default async function clusterRoutes(fastify: FastifyInstance) {
  /**
   * GET /servers
   * List all servers in the cluster (local + registered peers)
   * Includes resource info for all servers
   */
  fastify.get('/servers', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Get local resources (cached, never blocks)
    const localResources = resourceService.getResources();
    const clusterInfo = serverRegistry.getClusterInfo(localResources);
    return reply.send(clusterInfo);
  });

  /**
   * POST /servers/register
   * Register a peer server with this server
   * Body can include { resources } for initial resource info
   */
  fastify.post('/servers/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const { host, port, name, secret, resources } = request.body as any;

    if (!host || !port) {
      return reply.code(400).send({ error: 'host and port are required' });
    }

    const result = serverRegistry.register({ host, port, name, secret, resources });

    if (!result.success) {
      return reply.code(403).send({ error: result.error });
    }

    return reply.send({
      registered: true,
      serverId: result.serverId,
    });
  });

  /**
   * DELETE /servers/:serverId
   * Unregister a peer server
   */
  fastify.delete('/servers/:serverId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId } = request.params as any;
    const { secret } = request.body as any;

    // Validate secret if configured
    const clusterSecret = process.env.NEBULA_CLUSTER_SECRET;
    if (clusterSecret && secret !== clusterSecret) {
      return reply.code(403).send({ error: 'Invalid cluster secret' });
    }

    const removed = serverRegistry.unregister(serverId);

    if (!removed) {
      return reply.code(404).send({ error: 'Server not found' });
    }

    return reply.send({ unregistered: true });
  });

  /**
   * POST /servers/:serverId/heartbeat
   * Record heartbeat from a peer server
   * Body can include { resources } for system resource info
   */
  fastify.post('/servers/:serverId/heartbeat', async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId } = request.params as any;
    const { resources } = request.body as any;

    const success = serverRegistry.heartbeat(serverId, resources);

    if (!success) {
      return reply.code(404).send({ error: 'Server not found' });
    }

    return reply.send({ ok: true });
  });

  /**
   * GET /servers/:serverId
   * Get info about a specific server
   */
  fastify.get('/servers/:serverId', async (request: FastifyRequest, reply: FastifyReply) => {
    const { serverId } = request.params as any;

    const server = serverRegistry.getServer(serverId);

    if (!server) {
      return reply.code(404).send({ error: 'Server not found' });
    }

    return reply.send({
      id: server.id,
      name: server.name,
      url: server.url,
      status: server.status,
      registeredAt: server.registeredAt,
      lastHeartbeat: server.lastHeartbeat,
    });
  });
}
