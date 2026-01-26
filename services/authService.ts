/**
 * Auth Service - Frontend client for 2FA authentication
 *
 * Handles:
 * - Token storage in localStorage
 * - Auth status checking
 * - TOTP verification
 */

const API_BASE = '/api';
const TOKEN_KEY = 'nebula_auth_token';

export interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
}

export interface VerifyResponse {
  success: boolean;
  token?: string;
  error?: string;
}

class AuthService {
  private cachedStatus: AuthStatus | null = null;

  /**
   * Get the stored auth token
   */
  getToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  /**
   * Store auth token
   */
  setToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
  }

  /**
   * Clear stored token (logout)
   */
  clearToken(): void {
    localStorage.removeItem(TOKEN_KEY);
    this.cachedStatus = null;
  }

  /**
   * Get auth status from server
   * Returns cached status if available unless forceRefresh is true
   */
  async getStatus(forceRefresh = false): Promise<AuthStatus> {
    if (this.cachedStatus && !forceRefresh) {
      return this.cachedStatus;
    }

    const token = this.getToken();
    const headers: HeadersInit = {};

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(`${API_BASE}/auth/status`, { headers });
      const status = await response.json();
      this.cachedStatus = status;
      return status;
    } catch (error) {
      console.error('[Auth] Failed to get status:', error);
      return { configured: false, authenticated: false };
    }
  }

  /**
   * Verify TOTP code and get session token
   */
  async verify(code: string, trustBrowser: boolean): Promise<VerifyResponse> {
    try {
      const response = await fetch(`${API_BASE}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, trustBrowser }),
      });

      const data = await response.json();

      if (data.success && data.token) {
        this.setToken(data.token);
        this.cachedStatus = null; // Force refresh on next check
        return { success: true, token: data.token };
      }

      return { success: false, error: data.error || 'Verification failed' };
    } catch (error) {
      console.error('[Auth] Verification error:', error);
      return { success: false, error: 'Network error' };
    }
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const status = await this.getStatus();
    return status.authenticated;
  }

  /**
   * Logout - clear token
   */
  logout(): void {
    this.clearToken();
  }

  /**
   * Add auth header to fetch requests
   * Returns headers object with Authorization if token exists
   */
  getAuthHeaders(): HeadersInit {
    const token = this.getToken();
    if (token) {
      return { Authorization: `Bearer ${token}` };
    }
    return {};
  }

  /**
   * Get WebSocket URL with auth token
   */
  getAuthenticatedWebSocketUrl(baseUrl: string): string {
    const token = this.getToken();
    if (token) {
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}token=${encodeURIComponent(token)}`;
    }
    return baseUrl;
  }
}

// Export singleton instance
export const authService = new AuthService();
