/**
 * Auth Middleware - Protect routes and WebSocket connections
 *
 * Public routes (no auth required):
 * - /api/health
 * - /api/ready
 * - /api/auth/*
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import { authService } from './auth-service';
import { readClusterSecret } from '../cluster/cluster-secret';

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/api/health',
  '/api/ready',
  '/api/auth/status',
  '/api/auth/verify',
];

const CLUSTER_SECRET_HEADER = 'x-nebula-cluster-secret';

function isClientMode(): boolean {
  const explicit = process.env.NEBULA_CLIENT_MODE;
  if (explicit !== undefined) {
    return explicit === 'true';
  }
  return !!process.env.NEBULA_MAIN_SERVER;
}

function getClusterSecret(): string | null {
  return process.env.NEBULA_CLUSTER_SECRET || readClusterSecret() || null;
}

/**
 * Extract auth token from request
 * Checks Authorization header (Bearer token) and query parameter
 */
function extractToken(req: FastifyRequest | IncomingMessage): string | undefined {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check query parameter (for WebSocket connections)
  const url = 'url' in req ? (req as IncomingMessage).url : undefined;
  // For FastifyRequest, check query directly
  if ('query' in req && (req as any).query?.token) {
    return (req as any).query.token as string;
  }
  if (url) {
    const parsed = parseUrl(url, true);
    const token = parsed.query.token;
    if (typeof token === 'string') {
      return token;
    }
  }

  return undefined;
}

function extractClusterSecret(req: FastifyRequest | IncomingMessage): string | undefined {
  const headers = req.headers;
  const value = headers[CLUSTER_SECRET_HEADER] as string | string[] | undefined;
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function hasValidClusterSecret(req: FastifyRequest | IncomingMessage): boolean {
  const clusterSecret = getClusterSecret();
  if (!clusterSecret) {
    return false;
  }
  const provided = extractClusterSecret(req);
  return Boolean(provided && provided === clusterSecret);
}

function isClusterRoute(pathname: string): boolean {
  return pathname.startsWith('/api/servers') || pathname.startsWith('/servers');
}

/**
 * Check if a path is a public route
 */
function isPublicRoute(pathname: string): boolean {
  // Exact matches
  if (PUBLIC_ROUTES.includes(pathname)) {
    return true;
  }

  // Static files (frontend assets)
  if (!pathname.startsWith('/api/')) {
    return true;
  }

  return false;
}

/**
 * Fastify onRequest hook for authentication
 */
export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Reconstruct the full pathname including the prefix
  // Fastify strips the prefix when registering under /api, so we need the raw URL
  const pathname = request.url.split('?')[0];

  if (isClientMode()) {
    // Allow public routes regardless
    if (isPublicRoute(pathname)) {
      return;
    }
    if (!getClusterSecret()) {
      return reply.code(503).send({
        error: 'cluster_secret_required',
        message: 'Cluster secret required for client mode. Set NEBULA_CLUSTER_SECRET.',
      });
    }
    if (!hasValidClusterSecret(request)) {
      return reply.code(403).send({
        error: 'cluster_auth_required',
        message: 'Cluster authentication required.',
      });
    }
    return;
  }

  if (isClusterRoute(pathname) && hasValidClusterSecret(request)) {
    return;
  }

  if (authService.isAuthDisabled()) {
    return;
  }

  // Allow public routes
  if (isPublicRoute(pathname)) {
    return;
  }

  // Check if auth is configured
  if (!authService.isSetupComplete()) {
    // During setup, only allow auth routes
    return reply.code(503).send({
      error: 'setup_required',
      message: '2FA setup not complete. Check server terminal for QR code.',
    });
  }

  // Extract and validate token
  const token = extractToken(request);
  console.log(`[Auth-Debug] ${request.method} ${pathname} token=${token ? token.slice(0, 10) + '...' : 'NONE'} auth-header=${request.headers.authorization ? 'present' : 'missing'}`);
  if (!token) {
    return reply.code(401).send({
      error: 'auth_required',
      message: 'Authentication required. Please log in.',
    });
  }

  const payload = authService.validateToken(token);
  if (!payload) {
    console.log(`[Auth-Debug] Token validation FAILED for ${pathname}`);
    return reply.code(401).send({
      error: 'invalid_token',
      message: 'Invalid or expired token. Please log in again.',
    });
  }
  console.log(`[Auth-Debug] Token valid for ${pathname}`);

  // Token is valid, continue (simply return)
}

/**
 * WebSocket authentication middleware
 * Returns true if the connection is authenticated
 */
export function authWebSocketMiddleware(request: IncomingMessage): boolean {
  if (isClientMode()) {
    const clusterSecret = getClusterSecret();
    if (!clusterSecret) {
      console.log('[Auth] WebSocket rejected - cluster secret not configured');
      return false;
    }
    const provided = extractClusterSecret(request as any);
    if (provided !== clusterSecret) {
      console.log('[Auth] WebSocket rejected - invalid cluster secret');
      return false;
    }
    return true;
  }
  if (authService.isAuthDisabled()) {
    return true;
  }
  const url = request.url || '';
  const pathname = parseUrl(url).pathname || '';

  // Check if auth is configured
  if (!authService.isSetupComplete()) {
    console.log('[Auth] WebSocket rejected - setup not complete');
    return false;
  }

  // Extract and validate token from query parameter
  const token = extractToken(request);
  if (!token) {
    console.log('[Auth] WebSocket rejected - no token provided');
    return false;
  }

  const payload = authService.validateToken(token);
  if (!payload) {
    console.log('[Auth] WebSocket rejected - invalid token');
    return false;
  }

  return true;
}
