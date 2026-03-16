/**
 * Fastify App Setup - Shared middleware and configuration
 */

import Fastify, { FastifyInstance } from 'fastify';

export function createApp(): FastifyInstance {
  const bodyLimit =
    process.env.NEBULA_BODY_LIMIT ||
    process.env.NEBULA_MAX_BODY_SIZE ||
    '200mb';

  const app = Fastify({
    bodyLimit: parseBodyLimit(bodyLimit),
  });

  return app;
}

/**
 * Parse a human-readable body limit string (e.g., '200mb', '1gb') to bytes.
 */
function parseBodyLimit(limit: string): number {
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) {
    return 200 * 1024 * 1024; // default 200mb
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
