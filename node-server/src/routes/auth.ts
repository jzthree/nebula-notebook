/**
 * Auth Routes - API endpoints for 2FA authentication
 */

import { Router, Request, Response } from 'express';
import { authService } from '../auth/auth-service';

const router = Router();

/**
 * GET /api/auth/status
 * Check if 2FA is configured and if the current request is authenticated
 */
router.get('/auth/status', (req: Request, res: Response) => {
  // Extract token from Authorization header or query parameter
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  const status = authService.getAuthStatus(token);
  res.json(status);
});

/**
 * POST /api/auth/verify
 * Verify a TOTP code and issue a session token
 */
router.post('/auth/verify', (req: Request, res: Response) => {
  const { code, trustBrowser } = req.body;

  if (!code || typeof code !== 'string') {
    res.status(400).json({
      error: 'invalid_request',
      message: 'Verification code is required',
    });
    return;
  }

  // Clean the code (remove spaces)
  const cleanCode = code.replace(/\s/g, '');

  if (!/^\d{6}$/.test(cleanCode)) {
    res.status(400).json({
      error: 'invalid_format',
      message: 'Code must be 6 digits',
    });
    return;
  }

  const result = authService.verifyCode(cleanCode, !!trustBrowser);

  if (result.success) {
    res.json({
      success: true,
      token: result.token,
    });
  } else {
    res.status(401).json({
      success: false,
      error: result.error,
    });
  }
});

export default router;
