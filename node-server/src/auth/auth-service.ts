/**
 * Auth Service - TOTP-based 2FA authentication
 *
 * Handles:
 * - TOTP secret generation and verification
 * - JWT session token management
 * - Auth config persistence (~/.nebula/auth.json)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { authenticator } from 'otplib';
import * as jwt from 'jsonwebtoken';
import * as qrcode from 'qrcode-terminal';

// Config file location
const NEBULA_DIR = path.join(os.homedir(), '.nebula');
const AUTH_CONFIG_FILE = path.join(NEBULA_DIR, 'auth.json');

// JWT settings
const JWT_SECRET_LENGTH = 64;
const SHORT_SESSION_HOURS = 24;
const LONG_SESSION_DAYS = 30;

export interface AuthConfig {
  totpSecret: string;
  jwtSecret: string;
  setupComplete: boolean;
  createdAt: number;
}

export interface JWTPayload {
  iat: number;
  exp: number;
  trusted: boolean;
}

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

export interface VerifyResult {
  success: boolean;
  token?: string;
  error?: string;
}

class AuthService {
  private config: AuthConfig | null = null;
  private initialized = false;

  /**
   * Initialize the auth service
   * Returns true if setup is needed (first run)
   */
  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return !this.config?.setupComplete;
    }

    // Ensure .nebula directory exists
    if (!fs.existsSync(NEBULA_DIR)) {
      fs.mkdirSync(NEBULA_DIR, { recursive: true, mode: 0o700 });
    }

    // Try to load existing config
    if (fs.existsSync(AUTH_CONFIG_FILE)) {
      try {
        const data = fs.readFileSync(AUTH_CONFIG_FILE, 'utf-8');
        this.config = JSON.parse(data);
        this.initialized = true;
        return !this.config!.setupComplete;
      } catch (err) {
        console.error('[Auth] Failed to load auth config:', err);
      }
    }

    // No config exists - generate new secrets
    this.config = {
      totpSecret: authenticator.generateSecret(),
      jwtSecret: this.generateJWTSecret(),
      setupComplete: false,
      createdAt: Date.now(),
    };

    this.initialized = true;
    return true; // Setup needed
  }

  /**
   * Generate a secure random JWT secret
   */
  private generateJWTSecret(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    const randomBytes = require('crypto').randomBytes(JWT_SECRET_LENGTH);
    for (let i = 0; i < JWT_SECRET_LENGTH; i++) {
      result += chars[randomBytes[i] % chars.length];
    }
    return result;
  }

  /**
   * Save config to disk with secure permissions
   */
  private saveConfig(): void {
    if (!this.config) return;

    fs.writeFileSync(AUTH_CONFIG_FILE, JSON.stringify(this.config, null, 2), {
      mode: 0o600, // Owner read/write only
    });
  }

  /**
   * Print QR code and manual key to terminal for initial setup
   */
  printSetupInstructions(): void {
    if (!this.config) {
      console.error('[Auth] Cannot print setup - not initialized');
      return;
    }

    const issuer = 'NebulaNotebook';
    const accountName = 'local';
    const otpAuthUrl = authenticator.keyuri(accountName, issuer, this.config.totpSecret);

    console.log('\n' + '='.repeat(60));
    console.log('  NEBULA NOTEBOOK - 2FA SETUP');
    console.log('='.repeat(60));
    console.log('\nScan this QR code with your authenticator app:\n');

    // Print QR code to terminal
    qrcode.generate(otpAuthUrl, { small: true });

    console.log('\nOr enter this key manually: ' + this.config.totpSecret);
    console.log('\nThen open the Nebula UI and enter the 6-digit code.');
    console.log('='.repeat(60) + '\n');
  }

  /**
   * Check if 2FA setup is complete
   */
  isSetupComplete(): boolean {
    return this.config?.setupComplete ?? false;
  }

  /**
   * Verify a TOTP code and issue a JWT token
   */
  verifyCode(code: string, trustBrowser: boolean = false): VerifyResult {
    if (!this.config) {
      return { success: false, error: 'Auth not initialized' };
    }

    // Verify TOTP code
    const isValid = authenticator.verify({
      token: code,
      secret: this.config.totpSecret,
    });

    if (!isValid) {
      return { success: false, error: 'Invalid verification code' };
    }

    // Mark setup as complete on first successful verification
    if (!this.config.setupComplete) {
      this.config.setupComplete = true;
      this.saveConfig();
      console.log('[Auth] Setup complete - first verification successful');
    }

    // Issue JWT token
    const token = this.issueToken(trustBrowser);

    return { success: true, token };
  }

  /**
   * Issue a new JWT token
   */
  private issueToken(trusted: boolean): string {
    if (!this.config) {
      throw new Error('Auth not initialized');
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresIn = trusted
      ? LONG_SESSION_DAYS * 24 * 60 * 60 // 30 days
      : SHORT_SESSION_HOURS * 60 * 60; // 24 hours

    const payload: JWTPayload = {
      iat: now,
      exp: now + expiresIn,
      trusted,
    };

    return jwt.sign(payload, this.config.jwtSecret);
  }

  /**
   * Validate a JWT token
   * Returns the payload if valid, null if invalid
   */
  validateToken(token: string): JWTPayload | null {
    if (!this.config) {
      return null;
    }

    try {
      const payload = jwt.verify(token, this.config.jwtSecret) as JWTPayload;
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Get auth status for a request
   */
  getAuthStatus(token?: string): AuthStatus {
    const configured = this.config?.setupComplete ?? false;
    const authenticated = token ? this.validateToken(token) !== null : false;

    return { configured, authenticated };
  }

  /**
   * Get the TOTP secret (for testing only)
   * @internal
   */
  _getTotpSecret(): string | null {
    return this.config?.totpSecret ?? null;
  }
}

// Export singleton instance
export const authService = new AuthService();
