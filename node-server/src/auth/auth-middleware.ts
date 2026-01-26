/**
 * Auth Middleware - Protect routes and WebSocket connections
 *
 * Public routes (no auth required):
 * - /api/health
 * - /api/ready
 * - /api/auth/*
 */

import { Request, Response, NextFunction } from 'express';
import { IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import { authService } from './auth-service';

// Routes that don't require authentication
const PUBLIC_ROUTES = [
  '/api/health',
  '/api/ready',
  '/api/auth/status',
  '/api/auth/verify',
];

/**
 * Extract auth token from request
 * Checks Authorization header (Bearer token) and query parameter
 */
function extractToken(req: Request | IncomingMessage): string | undefined {
  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  // Check query parameter (for WebSocket connections)
  const url = 'url' in req ? req.url : (req as IncomingMessage).url;
  if (url) {
    const parsed = parseUrl(url, true);
    const token = parsed.query.token;
    if (typeof token === 'string') {
      return token;
    }
  }

  return undefined;
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
 * Express middleware for authentication
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const pathname = req.path;

  // Allow public routes
  if (isPublicRoute(pathname)) {
    next();
    return;
  }

  // Check if auth is configured
  if (!authService.isSetupComplete()) {
    // During setup, only allow auth routes
    res.status(503).json({
      error: 'setup_required',
      message: '2FA setup not complete. Check server terminal for QR code.',
    });
    return;
  }

  // Extract and validate token
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({
      error: 'auth_required',
      message: 'Authentication required. Please log in.',
    });
    return;
  }

  const payload = authService.validateToken(token);
  if (!payload) {
    res.status(401).json({
      error: 'invalid_token',
      message: 'Invalid or expired token. Please log in again.',
    });
    return;
  }

  // Token is valid, continue
  next();
}

/**
 * WebSocket authentication middleware
 * Returns true if the connection is authenticated
 */
export function authWebSocketMiddleware(request: IncomingMessage): boolean {
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
