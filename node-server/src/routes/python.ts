/**
 * Python Discovery API Routes
 */

import { Router, Request, Response } from 'express';
import { PythonDiscoveryService } from '../discovery/discovery-service';
import { discoverKernelSpecs, invalidateKernelspecCache } from '../kernel/kernelspec';
import { invalidateDefaultKernelName } from '../kernel/default-kernel';
import { serverRegistry } from '../cluster/server-registry';

const router = Router();
const discoveryService = new PythonDiscoveryService();

/**
 * List all discovered Python environments
 * Transforms to snake_case to match Python API format expected by frontend
 */
router.get('/python/environments', async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === 'true';
    const serverId = req.query.server_id as string | undefined;
    const localServerId = serverRegistry.getLocalServerId();

    if (serverId && serverId !== localServerId && serverId !== 'local') {
      const server = serverRegistry.getServer(serverId);
      if (!server) {
        res.status(404).json({ detail: `Server not found: ${serverId}` });
        return;
      }
      if (server.status !== 'online') {
        res.status(503).json({ detail: `Server is offline: ${serverId}` });
        return;
      }

      const response = await fetch(`${server.url}/api/python/environments?refresh=${refresh ? 'true' : 'false'}`, {
        headers: process.env.NEBULA_CLUSTER_SECRET ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET } : undefined,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
        res.status(response.status).json({ detail: error.detail || 'Failed to fetch Python environments' });
        return;
      }
      const data = await response.json();
      res.json(data);
      return;
    }

    // Get Jupyter kernelspecs and transform to snake_case
    const kernelspecs = discoverKernelSpecs(refresh).map(k => ({
      name: k.name,
      display_name: k.displayName,
      language: k.language,
      path: k.path,
      python_path: k.argv?.[0] || null, // First element of argv is typically the Python executable
    }));
    const kernelspecNames = new Set(kernelspecs.map(k => k.name));

    // Get discovered Python environments
    const environments = await discoveryService.discover({ forceRefresh: refresh });

    // Convert to snake_case and match with kernelspecs
    const envObjects = environments.map(env => ({
      path: env.path,
      version: env.version,
      display_name: env.displayName,
      env_type: env.envType,
      env_name: env.envName,
      has_ipykernel: env.hasIpykernel,
      kernel_name: env.kernelName && kernelspecNames.has(env.kernelName) ? env.kernelName : null,
    }));

    res.json({
      kernelspecs,
      environments: envObjects,
      cache_info: discoveryService.getCacheInfo(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Install ipykernel and register a Python environment as a Jupyter kernel
 */
router.post('/python/install-kernel', async (req: Request, res: Response) => {
  try {
    const { python_path, kernel_name, server_id } = req.body as {
      python_path?: string;
      kernel_name?: string;
      server_id?: string;
    };

    if (!python_path) {
      res.status(400).json({ detail: 'python_path is required' });
      return;
    }

    const localServerId = serverRegistry.getLocalServerId();
    if (server_id && server_id !== localServerId && server_id !== 'local') {
      const server = serverRegistry.getServer(server_id);
      if (!server) {
        res.status(404).json({ detail: `Server not found: ${server_id}` });
        return;
      }
      if (server.status !== 'online') {
        res.status(503).json({ detail: `Server is offline: ${server_id}` });
        return;
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
        const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
        res.status(response.status).json({ detail: error.detail || 'Failed to install kernel' });
        return;
      }
      const data = await response.json();
      res.json(data);
      return;
    }

    const result = await discoveryService.installKernel(python_path, kernel_name);
    // Invalidate kernelspec cache so the new kernel is discovered
    invalidateKernelspecCache();
    invalidateDefaultKernelName();
    res.json(result);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found') || err.message.includes('ENOENT')) {
        res.status(404).json({ detail: err.message });
      } else {
        res.status(500).json({ detail: err.message });
      }
    } else {
      res.status(500).json({ detail: 'Unknown error' });
    }
  }
});

/**
 * Force refresh the Python environment cache
 */
router.post('/python/refresh', async (_req: Request, res: Response) => {
  try {
    const serverId = _req.query.server_id as string | undefined;
    const localServerId = serverRegistry.getLocalServerId();
    if (serverId && serverId !== localServerId && serverId !== 'local') {
      const server = serverRegistry.getServer(serverId);
      if (!server) {
        res.status(404).json({ detail: `Server not found: ${serverId}` });
        return;
      }
      if (server.status !== 'online') {
        res.status(503).json({ detail: `Server is offline: ${serverId}` });
        return;
      }

      const response = await fetch(`${server.url}/api/python/refresh`, {
        headers: process.env.NEBULA_CLUSTER_SECRET ? { 'X-Nebula-Cluster-Secret': process.env.NEBULA_CLUSTER_SECRET } : undefined,
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
        res.status(response.status).json({ detail: error.detail || 'Failed to refresh Python environments' });
        return;
      }
      const data = await response.json();
      res.json(data);
      return;
    }

    const environments = await discoveryService.discover({ forceRefresh: true });
    res.json({
      count: environments.length,
      cache_info: discoveryService.getCacheInfo(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

export { discoveryService };
export default router;
