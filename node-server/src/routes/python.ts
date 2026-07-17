/**
 * Python Discovery API Routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pythonDiscovery } from '../discovery/discovery-service';
import { KernelProvisionError } from '../discovery/types';
import { discoverKernelSpecs, invalidateKernelspecCache } from '../kernel/kernelspec';
import { invalidateDefaultKernelName } from '../kernel/default-kernel';
import { serverRegistry } from '../cluster/server-registry';
import { kernelService } from './kernel';

// The shared singleton — kernel-service preflight/labels and per-env
// kernelspec scanning read its in-memory cache, so routes must write through
// the SAME instance (a second instance would leave the singleton stale).
const discoveryService = pythonDiscovery;

export default async function pythonRoutes(fastify: FastifyInstance) {
  /**
   * List all discovered Python environments
   * Transforms to snake_case to match Python API format expected by frontend
   */
  fastify.get('/python/environments', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const refresh = (request.query as any).refresh === 'true';
      const serverId = (request.query as any).server_id as string | undefined;
      const localServerId = serverRegistry.getLocalServerId();

      if (serverId && serverId !== localServerId && serverId !== 'local') {
        const server = serverRegistry.getServer(serverId);
        if (!server) {
          return reply.code(404).send({ detail: `Server not found: ${serverId}` });
        }
        if (server.status !== 'online') {
          return reply.code(503).send({ detail: `Server is offline: ${serverId}` });
        }

        const response = await fetch(`${server.url}/api/python/environments?refresh=${refresh ? 'true' : 'false'}`, {
          headers: process.env.NEBULA_CLUSTER_SECRET ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET } : undefined,
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
          return reply.code(response.status).send({ detail: error.detail || 'Failed to fetch Python environments' });
        }
        const data = await response.json();
        return reply.send(data);
      }

      // Discover Python environments FIRST: kernelspec discovery also scans
      // each known env's share/jupyter/kernels, so it must see the fresh list.
      const environments = await discoveryService.discover({ forceRefresh: refresh });

      // Get Jupyter kernelspecs and transform to snake_case
      const kernelspecs = discoverKernelSpecs(refresh).map(k => ({
        name: k.name,
        display_name: k.displayName,
        language: k.language,
        path: k.path,
        python_path: k.argv?.[0] || null, // First element of argv is typically the Python executable
      }));
      const kernelspecNames = new Set(kernelspecs.map(k => k.name));

      // Convert to snake_case and match with kernelspecs
      const envObjects = environments.map(env => ({
        path: env.path,
        version: env.version,
        display_name: env.displayName,
        env_type: env.envType,
        env_name: env.envName,
        has_ipykernel: env.hasIpykernel,
        externally_managed: env.externallyManaged,
        install_hint: env.installHint,
        kernel_name: env.kernelName && kernelspecNames.has(env.kernelName) ? env.kernelName : null,
      }));

      return reply.send({
        kernelspecs,
        environments: envObjects,
        cache_info: discoveryService.getCacheInfo(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Install ipykernel into an environment (no kernelspec registration — env
   * kernels raw-launch). One installer chosen up front (conda → uv → pip).
   *
   * Responds with an NDJSON stream so the UI can show installer output LIVE:
   *   {"type":"output","data":"…"}    — stdout/stderr chunks as they arrive
   *   {"type":"done","installer":…}   — success terminator
   *   {"type":"error","detail":…,"code":…,"install_hint":…} — failure terminator
   * Pre-stream validation failures are plain JSON error responses.
   */
  fastify.post('/python/install-ipykernel', async (request: FastifyRequest, reply: FastifyReply) => {
    const { python_path, server_id } = request.body as { python_path?: string; server_id?: string };
    if (!python_path) {
      return reply.code(400).send({ detail: 'python_path is required' });
    }

    const localServerId = serverRegistry.getLocalServerId();
    if (server_id && server_id !== localServerId && server_id !== 'local') {
      const server = serverRegistry.getServer(server_id);
      if (!server) {
        return reply.code(404).send({ detail: `Server not found: ${server_id}` });
      }
      if (server.status !== 'online') {
        return reply.code(503).send({ detail: `Server is offline: ${server_id}` });
      }
      const response = await fetch(`${server.url}/api/python/install-ipykernel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.NEBULA_CLUSTER_SECRET ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET } : {}),
        },
        body: JSON.stringify({ python_path }),
      });
      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string; code?: string; install_hint?: string };
        return reply.code(response.status).send({
          detail: error.detail || 'Failed to install ipykernel',
          code: error.code,
          install_hint: error.install_hint,
        });
      }
      // Pipe the remote NDJSON stream through untouched.
      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for await (const chunk of response.body as any) {
          reply.raw.write(chunk);
        }
      } catch { /* upstream died — terminate what we have */ }
      reply.raw.end();
      return reply;
    }

    // Local install: stream output as it happens, then a terminator event.
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
    const send = (obj: Record<string, unknown>) => reply.raw.write(`${JSON.stringify(obj)}\n`);
    try {
      const result = await discoveryService.installIpykernel(python_path, (chunk) => send({ type: 'output', data: chunk }));
      send({ type: 'done', installer: result.installer, message: result.message, python_path });
    } catch (err) {
      if (err instanceof KernelProvisionError) {
        send({ type: 'error', detail: err.message, code: err.code, install_hint: err.installHint });
      } else {
        send({ type: 'error', detail: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    reply.raw.end();
    return reply;
  });

  /**
   * Probe a manually-entered interpreter path ("Enter interpreter path…"):
   * validate it runs, classify + enrich it, persist it into the discovery
   * cache, and return it in the same snake_case shape as /python/environments.
   */
  fastify.post('/python/probe', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { python_path, server_id } = request.body as { python_path?: string; server_id?: string };
      if (!python_path) {
        return reply.code(400).send({ detail: 'python_path is required' });
      }

      const localServerId = serverRegistry.getLocalServerId();
      if (server_id && server_id !== localServerId && server_id !== 'local') {
        const server = serverRegistry.getServer(server_id);
        if (!server) {
          return reply.code(404).send({ detail: `Server not found: ${server_id}` });
        }
        if (server.status !== 'online') {
          return reply.code(503).send({ detail: `Server is offline: ${server_id}` });
        }
        const response = await fetch(`${server.url}/api/python/probe`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.NEBULA_CLUSTER_SECRET ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET } : {}),
          },
          body: JSON.stringify({ python_path }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string; code?: string; install_hint?: string };
          return reply.code(response.status).send({
            detail: error.detail || 'Failed to probe interpreter',
            code: error.code,
            install_hint: error.install_hint,
          });
        }
        return reply.send(await response.json());
      }

      const env = await discoveryService.probeAndRemember(python_path);
      return reply.send({
        path: env.path,
        version: env.version,
        display_name: env.displayName,
        env_type: env.envType,
        env_name: env.envName,
        has_ipykernel: env.hasIpykernel,
        externally_managed: env.externallyManaged,
        install_hint: env.installHint,
        kernel_name: env.kernelName,
      });
    } catch (err) {
      if (err instanceof KernelProvisionError) {
        const status = err.code === 'python_not_found' ? 404 : 500;
        return reply.code(status).send({ detail: err.message, code: err.code, install_hint: err.installHint });
      }
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Install ipykernel and register a Python environment as a Jupyter kernel
   */
  fastify.post('/python/install-kernel', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { python_path, kernel_name, server_id } = request.body as {
        python_path?: string;
        kernel_name?: string;
        server_id?: string;
      };

      if (!python_path) {
        return reply.code(400).send({ detail: 'python_path is required' });
      }

      const localServerId = serverRegistry.getLocalServerId();
      if (server_id && server_id !== localServerId && server_id !== 'local') {
        const server = serverRegistry.getServer(server_id);
        if (!server) {
          return reply.code(404).send({ detail: `Server not found: ${server_id}` });
        }
        if (server.status !== 'online') {
          return reply.code(503).send({ detail: `Server is offline: ${server_id}` });
        }

        const response = await fetch(`${server.url}/api/python/install-kernel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(process.env.NEBULA_CLUSTER_SECRET ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET } : {}),
          },
          body: JSON.stringify({ python_path, kernel_name }),
        });
        if (!response.ok) {
          // Forward the structured error (code + install_hint) so cluster clients
          // get the same guidance as a local externally-managed env.
          const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string; code?: string; install_hint?: string };
          return reply.code(response.status).send({
            detail: error.detail || 'Failed to install kernel',
            code: error.code,
            install_hint: error.install_hint,
          });
        }
        const data = await response.json();
        return reply.send(data);
      }

      const result = await discoveryService.installKernel(python_path, kernel_name);
      // Invalidate caches so the new kernel is discovered without a restart.
      invalidateKernelspecCache();
      invalidateDefaultKernelName();
      kernelService.refreshKernelSpecs();
      // snake_case to match the frontend KernelService client contract.
      return reply.send({
        kernel_name: result.kernelName,
        python_path: result.pythonPath,
        message: result.message,
      });
    } catch (err) {
      // Structured provisioning errors carry a stable code + guidance hint so the
      // UI can show actionable help instead of a raw traceback.
      if (err instanceof KernelProvisionError) {
        const status = err.code === 'python_not_found' ? 404
          : err.code === 'externally_managed' || err.code === 'needs_ipykernel' ? 422
          : 500;
        return reply.code(status).send({ detail: err.message, code: err.code, install_hint: err.installHint });
      }
      if (err instanceof Error) {
        if (err.message.includes('not found') || err.message.includes('ENOENT')) {
          return reply.code(404).send({ detail: err.message });
        } else {
          return reply.code(500).send({ detail: err.message });
        }
      } else {
        return reply.code(500).send({ detail: 'Unknown error' });
      }
    }
  });

  /**
   * Force refresh the Python environment cache
   */
  fastify.post('/python/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const serverId = (request.query as any).server_id as string | undefined;
      const localServerId = serverRegistry.getLocalServerId();
      if (serverId && serverId !== localServerId && serverId !== 'local') {
        const server = serverRegistry.getServer(serverId);
        if (!server) {
          return reply.code(404).send({ detail: `Server not found: ${serverId}` });
        }
        if (server.status !== 'online') {
          return reply.code(503).send({ detail: `Server is offline: ${serverId}` });
        }

        const response = await fetch(`${server.url}/api/python/refresh`, {
          headers: process.env.NEBULA_CLUSTER_SECRET ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET } : undefined,
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
          return reply.code(response.status).send({ detail: error.detail || 'Failed to refresh Python environments' });
        }
        const data = await response.json();
        return reply.send(data);
      }

      const environments = await discoveryService.discover({ forceRefresh: true });
      return reply.send({
        count: environments.length,
        cache_info: discoveryService.getCacheInfo(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });
}

export { discoveryService };

