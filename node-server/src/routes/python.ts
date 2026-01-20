/**
 * Python Discovery API Routes
 */

import { Router, Request, Response } from 'express';
import { PythonDiscoveryService } from '../discovery/discovery-service';
import { discoverKernelSpecs } from '../kernel/kernelspec';

const router = Router();
const discoveryService = new PythonDiscoveryService();

/**
 * List all discovered Python environments
 */
router.get('/python/environments', async (req: Request, res: Response) => {
  try {
    const refresh = req.query.refresh === 'true';

    // Get Jupyter kernelspecs
    const kernelspecs = discoverKernelSpecs();
    const kernelspecNames = new Set(kernelspecs.map(k => k.name));

    // Get discovered Python environments
    const environments = await discoveryService.discover({ forceRefresh: refresh });

    // Convert to plain objects and match with kernelspecs
    const envObjects = environments.map(env => ({
      path: env.path,
      version: env.version,
      displayName: env.displayName,
      envType: env.envType,
      envName: env.envName,
      hasIpykernel: env.hasIpykernel,
      kernelName: env.kernelName && kernelspecNames.has(env.kernelName) ? env.kernelName : null,
    }));

    res.json({
      kernelspecs,
      environments: envObjects,
      cache_info: discoveryService.getCacheInfo(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Install ipykernel and register a Python environment as a Jupyter kernel
 */
router.post('/python/install-kernel', async (req: Request, res: Response) => {
  try {
    const { python_path, kernel_name } = req.body;

    if (!python_path) {
      res.status(400).json({ error: 'python_path is required' });
      return;
    }

    const result = await discoveryService.installKernel(python_path, kernel_name);
    res.json(result);
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('not found') || err.message.includes('ENOENT')) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(500).json({ error: err.message });
      }
    } else {
      res.status(500).json({ error: 'Unknown error' });
    }
  }
});

/**
 * Force refresh the Python environment cache
 */
router.post('/python/refresh', async (_req: Request, res: Response) => {
  try {
    const environments = await discoveryService.discover({ forceRefresh: true });
    res.json({
      count: environments.length,
      cache_info: discoveryService.getCacheInfo(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

export { discoveryService };
export default router;
