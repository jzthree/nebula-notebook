/**
 * Nebula Node Server - Main Entry Point
 *
 * Unified Node.js server for:
 * - Jupyter kernel management
 * - LLM providers (Google, OpenAI, Anthropic)
 * - Filesystem operations
 * - Python environment discovery
 * - Terminal PTY management
 */

import { createServer, IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import express, { Request, Response, NextFunction, Express } from 'express';
import cors from 'cors';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { randomUUID } from 'crypto';

// Import routes
import kernelRoutes, { setupKernelWebSocket, kernelService } from './routes/kernel';
import llmRoutes, { llmService } from './routes/llm';
import fsRoutes from './routes/fs';
import notebookRoutes from './routes/notebook';
import pythonRoutes from './routes/python';
import authRoutes from './routes/auth';
import clusterRoutes from './routes/cluster';
import resourceRoutes from './routes/resources';

// Import cluster
import { serverRegistry } from './cluster/server-registry';
import { getOrCreateClusterSecret } from './cluster/cluster-secret';
import { clientRegistration } from './cluster/client-registration';

// Import auth
import { authService, authMiddleware, authWebSocketMiddleware } from './auth';
import { fsService } from './fs/fs-service';

// Import terminal routes (existing)
import { setupTerminalRoutes, setupTerminalWebSocket, cleanupTerminals } from './terminal/server';

// Import notebook WebSocket
import { setupNotebookWebSocket } from './notebook/notebook-websocket';

const PORT = process.env.PORT || process.env.NODE_SERVER_PORT || 3000;
const DEV_MODE = process.env.DEV_MODE === 'true' || process.argv.includes('--dev');
const BODY_LIMIT =
  process.env.NEBULA_BODY_LIMIT ||
  process.env.NEBULA_MAX_BODY_SIZE ||
  '200mb';
const CLIENT_MODE =
  process.argv.includes('--client') ||
  process.argv.includes('--client-mode') ||
  process.env.NEBULA_CLIENT === 'true' ||
  process.env.NEBULA_CLIENT_MODE === 'true' ||
  process.env.npm_config_client === 'true' ||
  process.env.npm_config_client === '1';
const getArgValue = (name: string): string | null => {
  const idx = process.argv.findIndex(arg => arg === name);
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  const prefix = `${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  if (found) {
    return found.slice(prefix.length);
  }
  return null;
};
const WORKDIR = getArgValue('--workdir') || process.env.NEBULA_WORKDIR || process.env.npm_config_workdir;
const PRESERVE_KERNELS =
  process.argv.includes('--preserve-kernels') ||
  process.argv.includes('--preserve-kernel') ||
  process.env.NEBULA_PRESERVE_KERNELS === 'true' ||
  process.env.npm_config_preserve_kernels === 'true' ||
  process.env.npm_config_preserve_kernels === '1';
const REATTACH_KERNELS =
  process.argv.includes('--reattach-kernels') ||
  process.argv.includes('--reattach-kernel') ||
  process.env.NEBULA_REATTACH_KERNELS === 'true' ||
  process.env.npm_config_reattach_kernels === 'true' ||
  process.env.npm_config_reattach_kernels === '1';

// Log kernel preservation settings
if (PRESERVE_KERNELS) console.log('[Server] Kernel preservation ENABLED');
if (REATTACH_KERNELS) console.log('[Server] Kernel reattachment ENABLED');

/**
 * Create and configure Express app
 */
function createApp(): Express {
  const app = express();

  // Request timing middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > 1000) {
        console.log(`[Slow Request] ${req.method} ${req.path} - ${duration}ms`);
      }
    });
    next();
  });

  // CORS
  app.use(cors({
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-API-Provider'],
  }));

  // JSON body parser with larger limit for notebook data
  app.use(express.json({ limit: BODY_LIMIT }));
  app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

  // Health check endpoints
  app.get('/api/health', (_req: Request, res: Response) => {
    // Use configured root directory (from .nebula-config.json or fallback to cwd)
    const rootDir = fsService.normalizePath('~');
    res.json({
      status: 'ok',
      version: '1.0.0',
      ready: kernelService.isReady,
      llm_providers: Object.keys(llmService.getAvailableProviders()),
      cwd: rootDir,
    });
  });

  app.get('/api/ready', (_req: Request, res: Response) => {
    if (!kernelService.isReady) {
      res.status(503).json({
        detail: 'Service initializing, kernel discovery in progress',
      });
      return;
    }
    res.json({ status: 'ready' });
  });

  // Auth routes (public - no auth required)
  app.use('/api', authRoutes);

  // Auth middleware - protect all other API routes
  app.use('/api', authMiddleware);

  // API routes (protected)
  app.use('/api', kernelRoutes);
  app.use('/api', llmRoutes);
  app.use('/api', fsRoutes);
  app.use('/api', notebookRoutes);
  app.use('/api', pythonRoutes);
  app.use('/api', clusterRoutes);
  app.use('/api/resources', resourceRoutes);

  // Terminal routes
  setupTerminalRoutes(app);

  return app;
}

/**
 * Setup WebSocket routing
 */
function setupWebSockets(server: ReturnType<typeof createServer>): void {
  // Create WebSocket server with noServer mode for path-based routing
  // Disable per-message deflate to avoid compression issues with proxies/browsers
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });

  // Handle upgrade requests
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = parseUrl(request.url || '').pathname || '';

    // Route to kernel WebSocket
    if (pathname.match(/^\/api\/kernels\/[^/]+\/ws$/)) {
      // Authenticate WebSocket connection
      if (!authWebSocketMiddleware(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Terminal WebSocket (/ws) is handled by setupTerminalWebSocket
    // Don't destroy socket for other paths - let other handlers deal with them
  });

  // Setup kernel WebSocket handler
  setupKernelWebSocket(wss);
}

/**
 * Setup static file serving for frontend
 */
function setupStaticServing(app: Express): void {
  const distDir = path.join(__dirname, '../../dist');

  if (DEV_MODE) {
    console.log('[Server] Development mode - frontend should run separately with npm run dev');
    return;
  }

  // Production mode: serve from dist
  if (fs.existsSync(distDir)) {
    // Serve static files
    app.use(express.static(distDir));

    // SPA fallback - serve index.html for all non-API routes
    app.get('*', (req: Request, res: Response) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ detail: 'Not found' });
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });

    console.log(`[Server] Serving frontend from ${distDir}`);
  } else {
    console.log(`[Server] Warning: dist directory not found at ${distDir}`);
    console.log('[Server] Run "npm run build" to create the production build');
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('[Server] Starting Nebula Node Server...');

  const mainServerUrl = process.env.NEBULA_MAIN_SERVER;

  if (CLIENT_MODE && !mainServerUrl) {
    console.error('[Cluster] Client mode requested but NEBULA_MAIN_SERVER is not set.');
    console.error('[Cluster] Set NEBULA_MAIN_SERVER or remove --client.');
    process.exit(1);
  }

  process.env.NEBULA_CLIENT_MODE = CLIENT_MODE ? 'true' : 'false';

  if (!process.env.NEBULA_CLUSTER_SECRET) {
    const allowCreate = !CLIENT_MODE;
    const secret = getOrCreateClusterSecret({ allowCreate });
    if (secret) {
      process.env.NEBULA_CLUSTER_SECRET = secret;
      if (allowCreate) {
        console.log('[Cluster] Generated cluster secret (stored at ~/.nebula/cluster.json)');
      }
    } else if (CLIENT_MODE) {
      console.error('[Cluster] No NEBULA_CLUSTER_SECRET set and no ~/.nebula/cluster.json found.');
      console.error('[Cluster] Set NEBULA_CLUSTER_SECRET or copy ~/.nebula/cluster.json from the main server.');
      process.exit(1);
    }
  }

  const authDisabled =
    process.argv.includes('--noauth') ||
    process.argv.includes('--no-auth') ||
    process.env.NO_AUTH === 'true' ||
    process.env.NEBULA_NO_AUTH === 'true' ||
    process.env.npm_config_noauth === 'true' ||
    process.env.npm_config_noauth === '1' ||
    process.env.npm_config_no_auth === 'true' ||
    process.env.npm_config_no_auth === '1' ||
    CLIENT_MODE;

  if (authDisabled) {
    authService.disableAuth();
    console.log(`[Auth] Disabled (${CLIENT_MODE ? 'client mode' : '--noauth'})`);
  }
  if (WORKDIR) {
    try {
      const updated = fsService.setRootDirectory(WORKDIR);
      console.log(`[Server] Root directory set to ${updated}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Server] Failed to set root directory: ${message}`);
    }
  }
  if (PRESERVE_KERNELS) {
    console.log('[Kernel] Preserve kernels enabled');
  }
  if (REATTACH_KERNELS) {
    console.log('[Kernel] Reattach kernels on startup enabled');
  }

  // Initialize authentication
  const setupNeeded = await authService.initialize();
  if (setupNeeded) {
    authService.printSetupInstructions();
  } else {
    console.log('[Auth] 2FA configured and ready');
  }

  // Set local server ID from hostname
  const localServerId = `${os.hostname()}:${PORT}`;
  serverRegistry.setLocalServerId(localServerId);
  console.log(`[Cluster] Local server ID: ${localServerId}`);
  const serverInstanceId = randomUUID();
  process.env.NEBULA_SERVER_ID = localServerId;
  process.env.NEBULA_SERVER_INSTANCE_ID = serverInstanceId;
  kernelService.setServerIdentity(localServerId, serverInstanceId);

  // Create Express app
  const app = createApp();

  // Create HTTP server
  const server = createServer(app);

  // Setup WebSocket routing
  setupWebSockets(server);

  // Setup terminal WebSocket (now using noServer mode)
  setupTerminalWebSocket(server);

  // Setup notebook operations WebSocket
  setupNotebookWebSocket(server);

  // Setup static file serving
  setupStaticServing(app);

  if (REATTACH_KERNELS) {
    try {
      const result = await kernelService.reattachOrphanedSessions();
      if (result.attempted > 0) {
        console.log(`[Kernel] Reattach summary: ${result.reattached} reattached, ${result.failed} failed, ${result.skipped} skipped`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[Kernel] Reattach failed: ${message}`);
    }
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[Server] Shutting down...');
    console.log(`[Server] PRESERVE_KERNELS=${PRESERVE_KERNELS}`);

    // Cleanup terminals
    cleanupTerminals();

    // Cleanup kernel sessions
    try {
      await kernelService.shutdown({ preserveKernels: PRESERVE_KERNELS });
    } catch (err) {
      console.error('[Server] Error during kernel cleanup:', err);
    }

    // Cleanup cluster registration
    try {
      await clientRegistration.shutdown();
      serverRegistry.shutdown();
    } catch (err) {
      console.error('[Server] Error during cluster cleanup:', err);
    }

    server.close(() => {
      console.log('[Server] Server closed');
      process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => {
      console.log('[Server] Forcing exit after timeout');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start server
  server.listen(PORT, () => {
    const mode = DEV_MODE ? 'development' : 'production';
    console.log(`[Server] Nebula running on http://localhost:${PORT} (${mode} mode)`);
    console.log(`[Server] API endpoints: http://localhost:${PORT}/api/*`);
    console.log(`[Server] Kernel WebSocket: ws://localhost:${PORT}/api/kernels/{session_id}/ws`);
    console.log(`[Server] Notebook WebSocket: ws://localhost:${PORT}/api/notebook/{path}/ws`);
    console.log(`[Server] Terminal WebSocket: ws://localhost:${PORT}/ws?id={terminal_id}`);
    console.log(`[Server] Root directory: ${fsService.getRootDirectory()} (change with --workdir)`);

  // Initialize client registration (explicit client mode only)
  if (CLIENT_MODE) {
    clientRegistration.initFromEnv(Number(PORT));
  }
  });
}

// Run
main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
