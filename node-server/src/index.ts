/**
 * Nebula Node Server - Main Entry Point
 *
 * Unified Node.js server for:
 * - Jupyter kernel management
 * - LLM providers (Google, OpenAI, Anthropic)
 * - Filesystem operations
 * - Python environment discovery
 * - Terminal PTY management
 *
 * Uses Fastify with HTTP/2 support.
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
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
  '1gb';
const CLIENT_MODE =
  process.argv.includes('--client') ||
  process.argv.includes('--client-mode') ||
  process.env.NEBULA_CLIENT === 'true' ||
  process.env.NEBULA_CLIENT_MODE === 'true' ||
  process.env.npm_config_client === 'true' ||
  process.env.npm_config_client === '1';
const hasCliFlag = (names: string[]): boolean => names.some(name => process.argv.includes(name));
const parseOptionalBoolean = (value: string | undefined): boolean | null => {
  if (value === undefined) return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
};
const resolveBooleanFlag = (
  enabledCliFlags: string[],
  disabledCliFlags: string[],
  envNames: string[],
  npmConfigNames: string[],
  defaultValue: boolean
): boolean => {
  if (hasCliFlag(disabledCliFlags)) return false;
  if (hasCliFlag(enabledCliFlags)) return true;

  for (const envName of [...envNames, ...npmConfigNames]) {
    const resolved = parseOptionalBoolean(process.env[envName]);
    if (resolved !== null) {
      return resolved;
    }
  }

  return defaultValue;
};
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
const PRESERVE_KERNELS = resolveBooleanFlag(
  ['--preserve-kernels', '--preserve-kernel'],
  ['--no-preserve-kernels', '--no-preserve-kernel'],
  ['NEBULA_PRESERVE_KERNELS'],
  ['npm_config_preserve_kernels'],
  DEV_MODE
);
const REATTACH_KERNELS = resolveBooleanFlag(
  ['--reattach-kernels', '--reattach-kernel'],
  ['--no-reattach-kernels', '--no-reattach-kernel'],
  ['NEBULA_REATTACH_KERNELS'],
  ['npm_config_reattach_kernels'],
  DEV_MODE
);

// Log kernel preservation settings
if (PRESERVE_KERNELS) console.log('[Server] Kernel preservation ENABLED');
if (REATTACH_KERNELS) console.log('[Server] Kernel reattachment ENABLED');

/**
 * Parse a human-readable body limit string (e.g., '200mb', '1gb') to bytes.
 */
function parseBodyLimit(limit: string): number {
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) {
    return 1024 * 1024 * 1024; // default 1gb
  }
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };
  return Math.floor(value * (multipliers[unit] || 1));
}

/**
 * Generate or load self-signed TLS certificate for HTTP/2
 */
function getOrCreateTlsCert(): { key: Buffer; cert: Buffer } | null {
  const tlsDir = path.join(os.homedir(), '.nebula', 'tls');
  const keyPath = path.join(tlsDir, 'server.key');
  const certPath = path.join(tlsDir, 'server.cert');

  try {
    // Check if cert already exists and is still valid
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      const key = fs.readFileSync(keyPath);
      const cert = fs.readFileSync(certPath);
      return { key, cert };
    }

    // Generate self-signed certificate using Node.js crypto
    // Only available in Node.js 15+
    if (!('generateKeyPairSync' in crypto)) {
      console.log('[TLS] crypto.generateKeyPairSync not available, falling back to HTTP/1.1');
      return null;
    }

    console.log('[TLS] Generating self-signed certificate for HTTP/2...');

    // Create TLS directory
    fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });

    // Use child_process to generate cert with openssl (most portable approach)
    const { execSync } = require('child_process');
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=localhost"`,
        { stdio: 'pipe' }
      );
      fs.chmodSync(keyPath, 0o600);
      fs.chmodSync(certPath, 0o600);

      const key = fs.readFileSync(keyPath);
      const cert = fs.readFileSync(certPath);
      console.log('[TLS] Self-signed certificate generated and cached at ~/.nebula/tls/');
      return { key, cert };
    } catch (err) {
      console.log('[TLS] openssl not available, falling back to HTTP/1.1');
      return null;
    }
  } catch (err) {
    console.log('[TLS] Failed to generate certificate, falling back to HTTP/1.1');
    return null;
  }
}

/**
 * Create and configure Fastify app
 */
async function createApp(): Promise<FastifyInstance> {
  const bodyLimitBytes = parseBodyLimit(BODY_LIMIT);

  // Try to get TLS certs for HTTP/2
  const tlsCert = getOrCreateTlsCert();

  let fastify: FastifyInstance;

  if (tlsCert) {
    // Cast to FastifyInstance to unify the type with the HTTP/1 branch.
    // The HTTP/2 Fastify instance is a superset but TypeScript infers a
    // different generic specialisation; the cast is safe because we only
    // use the common API surface.
    fastify = Fastify({
      http2: true,
      https: {
        key: tlsCert.key,
        cert: tlsCert.cert,
        allowHTTP1: true,
      },
      bodyLimit: bodyLimitBytes,
    }) as unknown as FastifyInstance;
    console.log('[Server] HTTP/2 with TLS enabled');
  } else {
    fastify = Fastify({
      bodyLimit: bodyLimitBytes,
    });
    console.log('[Server] HTTP/1.1 mode (no TLS)');
  }

  // Request timing hook
  fastify.addHook('onResponse', (request, reply, done) => {
    const duration = reply.elapsedTime;
    if (duration > 1000) {
      console.log(`[Slow Request] ${request.method} ${request.url} - ${Math.round(duration)}ms`);
    }
    done();
  });

  // Register CORS
  await fastify.register(fastifyCors, {
    origin: '*',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-API-Provider'],
  });

  // Register multipart support (replaces multer)
  await fastify.register(fastifyMultipart, {
    limits: {
      fileSize: bodyLimitBytes,
    },
  });

  // Health check endpoints (public - no auth required)
  fastify.get('/api/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Use configured root directory (from .nebula-config.json or fallback to cwd)
    const rootDir = fsService.normalizePath('~');
    return reply.send({
      status: 'ok',
      version: '1.0.0',
      ready: kernelService.isReady,
      llm_providers: Object.keys(llmService.getAvailableProviders()),
      cwd: rootDir,
    });
  });

  fastify.get('/api/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!kernelService.isReady) {
      return reply.code(503).send({
        detail: 'Service initializing, kernel discovery in progress',
      });
    }
    return reply.send({ status: 'ready' });
  });

  // Auth routes (public - no auth required)
  await fastify.register(authRoutes, { prefix: '/api' });

  // Auth middleware - protect all other API routes
  // Applied as an onRequest hook for /api/* routes (excluding public ones)
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = request.url.split('?')[0];
    // Skip health, ready, and auth routes (they are public)
    if (
      pathname === '/api/health' ||
      pathname === '/api/ready' ||
      pathname.startsWith('/api/auth/')
    ) {
      return;
    }
    // Skip non-API routes (static files etc)
    if (!pathname.startsWith('/api/')) {
      return;
    }
    // Apply auth middleware
    await authMiddleware(request, reply);
  });

  // API routes (protected)
  await fastify.register(kernelRoutes, { prefix: '/api' });
  await fastify.register(llmRoutes, { prefix: '/api' });
  await fastify.register(fsRoutes, { prefix: '/api' });
  await fastify.register(notebookRoutes, { prefix: '/api' });
  await fastify.register(pythonRoutes, { prefix: '/api' });
  await fastify.register(clusterRoutes, { prefix: '/api' });
  await fastify.register(resourceRoutes, { prefix: '/api/resources' });

  // Terminal routes (registered directly on the app, not under /api prefix)
  await fastify.register(setupTerminalRoutes);

  return fastify;
}

/**
 * Setup WebSocket routing (kernel, terminal, notebook)
 * Uses the raw Node.js HTTP(S) server from Fastify for upgrade handling
 */
function setupWebSockets(server: FastifyInstance['server']): void {
  // Create WebSocket server with noServer mode for path-based routing
  // Disable per-message deflate to avoid compression issues with proxies/browsers
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });

  // Handle upgrade requests
  server.on('upgrade', (request: IncomingMessage, socket: any, head: Buffer) => {
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
async function setupStaticServing(fastify: FastifyInstance): Promise<void> {
  const distDir = path.join(__dirname, '../../dist');

  if (DEV_MODE) {
    console.log('[Server] Development mode - frontend should run separately with npm run dev');
    return;
  }

  // Production mode: serve from dist
  if (fs.existsSync(distDir)) {
    // Serve static files
    await fastify.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback - serve index.html for all non-API routes
    fastify.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
      const pathname = request.url.split('?')[0];
      if (pathname.startsWith('/api/')) {
        return reply.code(404).send({ detail: 'Not found' });
      }
      return reply.sendFile('index.html');
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

  // Create Fastify app
  const fastify = await createApp();

  // Setup static file serving
  await setupStaticServing(fastify);

  // Start Fastify and get the underlying HTTP(S) server
  await fastify.listen({ port: Number(PORT), host: '0.0.0.0' });

  // Get the raw Node.js server for WebSocket handling
  const server = fastify.server;

  // Setup WebSocket routing (kernel)
  setupWebSockets(server);

  // Setup terminal WebSocket (now using noServer mode)
  setupTerminalWebSocket(server);

  // Setup notebook operations WebSocket
  setupNotebookWebSocket(server);

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

    await fastify.close();
    console.log('[Server] Server closed');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const protocol = fastify.server.constructor.name.includes('Secure') ? 'https' : 'http';
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  const mode = DEV_MODE ? 'development' : 'production';
  console.log(`[Server] Nebula running on ${protocol}://localhost:${PORT} (${mode} mode)`);
  console.log(`[Server] API endpoints: ${protocol}://localhost:${PORT}/api/*`);
  console.log(`[Server] Kernel WebSocket: ${wsProtocol}://localhost:${PORT}/api/kernels/{session_id}/ws`);
  console.log(`[Server] Notebook WebSocket: ${wsProtocol}://localhost:${PORT}/api/notebook/{path}/ws`);
  console.log(`[Server] Terminal WebSocket: ${wsProtocol}://localhost:${PORT}/ws?id={terminal_id}`);
  console.log(`[Server] Root directory: ${fsService.getRootDirectory()} (change with --workdir)`);

  // Initialize client registration (explicit client mode only)
  if (CLIENT_MODE) {
    clientRegistration.initFromEnv(Number(PORT));
  }
}

// Run
main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
