/**
 * Auth Routes - API endpoints for 2FA authentication
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authService } from '../auth/auth-service';

export default async function authRoutes(fastify: FastifyInstance) {
  /**
   * GET /auth/status
   * Check if 2FA is configured and if the current request is authenticated
   */
  fastify.get('/auth/status', async (request: FastifyRequest, reply: FastifyReply) => {
    // Extract token from Authorization header or query parameter
    let token: string | undefined;

    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    const status = authService.getAuthStatus(token);
    return reply.send(status);
  });

  /**
   * POST /auth/verify
   * Verify a TOTP code and issue a session token
   */
  fastify.post('/auth/verify', async (request: FastifyRequest, reply: FastifyReply) => {
    const { code, trustBrowser } = request.body as any;

    if (!code || typeof code !== 'string') {
      return reply.code(400).send({
        error: 'invalid_request',
        message: 'Verification code is required',
      });
    }

    // Clean the code (remove spaces)
    const cleanCode = code.replace(/\s/g, '');

    if (!/^\d{6}$/.test(cleanCode)) {
      return reply.code(400).send({
        error: 'invalid_format',
        message: 'Code must be 6 digits',
      });
    }

    const result = authService.verifyCode(cleanCode, !!trustBrowser);

    if (result.success) {
      return reply.send({
        success: true,
        token: result.token,
      });
    } else {
      return reply.code(401).send({
        success: false,
        error: result.error,
      });
    }
  });
}
