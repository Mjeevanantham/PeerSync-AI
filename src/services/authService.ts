/**
 * PeerSync Dev Connect - Authentication Service
 * 
 * Handles user authentication, token management, and session persistence.
 * Provides secure storage for credentials and automatic token refresh.
 * 
 * TODO: [ ] OAuth integration (GitHub, Google, Microsoft)
 * TODO: [ ] Enterprise SSO (SAML, OIDC)
 * TODO: [ ] Biometric authentication support
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { 
  STORAGE_KEYS, 
  API_ENDPOINTS, 
  CONFIG_KEYS, 
  ERROR_CODES,
  DEFAULTS 
} from '../utils/constants';
import type { 
  Session, 
  AuthTokens, 
  UserProfile 
} from '../models/session';
import { createEmptySession, areTokensExpired } from '../models/session';

/**
 * Login credentials (production: backend dev-token uses email + displayName)
 */
export interface LoginCredentials {
  email: string;
  displayName: string;
}

/**
 * Login response from the server
 */
interface LoginResponse {
  success: boolean;
  tokens?: AuthTokens;
  profile?: UserProfile;
  error?: string;
}

/**
 * Authentication event types
 */
export type AuthEventType = 'login' | 'logout' | 'refresh' | 'expired';

/**
 * Authentication event listener
 */
export type AuthEventListener = (event: AuthEventType, session: Session | null) => void;

/**
 * Authentication Service
 * 
 * Manages user authentication state, token lifecycle, and secure storage.
 */
export class AuthService {
  private session: Session;
  private readonly context: vscode.ExtensionContext;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly listeners: Set<AuthEventListener> = new Set();
  private readonly log = logger.createChildLogger('AuthService');

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.session = createEmptySession();
  }

  /**
   * Initialize the authentication service
   */
  public async initialize(): Promise<void> {
    this.log.info('Initializing authentication service');
    
    try {
      await this.loadSession();
      
      if (this.session.isAuthenticated && this.session.tokens) {
        if (areTokensExpired(this.session.tokens)) {
          this.log.info('Session tokens expired, attempting refresh');
          await this.refreshTokens();
        } else {
          this.scheduleTokenRefresh();
        }
      }
    } catch (error) {
      this.log.error('Failed to initialize auth service', error as Error);
      await this.clearSession();
    }
  }

  /**
   * Login with email and password
   */
  public async login(credentials: LoginCredentials): Promise<boolean> {
    this.log.info('Attempting login', { email: credentials.email });
    
    try {
      // TODO: [ ] Replace with actual API call
      const response = await this.performLogin(credentials);
      
      if (response.success && response.tokens && response.profile) {
        this.session = {
          isAuthenticated: true,
          profile: response.profile,
          tokens: response.tokens,
          createdAt: new Date().toISOString(),
          lastRefreshedAt: new Date().toISOString(),
        };
        
        await this.persistSession();
        this.scheduleTokenRefresh();
        this.notifyListeners('login');
        
        this.log.info('Login successful', { userId: response.profile.id });
        return true;
      }
      
      this.log.warn('Login failed', { error: response.error });
      return false;
    } catch (error) {
      this.log.error('Login error', error as Error);
      throw error;
    }
  }

  /**
   * Logout the current user
   */
  public async logout(): Promise<void> {
    this.log.info('Logging out user');
    
    try {
      if (this.session.isAuthenticated) {
        // TODO: [ ] Call logout API to invalidate tokens on server
        await this.performLogout();
      }
    } catch (error) {
      this.log.warn('Logout API call failed', { error });
    } finally {
      await this.clearSession();
      this.notifyListeners('logout');
    }
  }

  /**
   * Get the current session
   */
  public getSession(): Session {
    return { ...this.session };
  }

  /**
   * Check if user is authenticated
   */
  public isAuthenticated(): boolean {
    return this.session.isAuthenticated;
  }

  /**
   * Get current user profile
   */
  public getProfile(): UserProfile | null {
    return this.session.profile ? { ...this.session.profile } : null;
  }

  /**
   * Get current access token
   */
  public getAccessToken(): string | null {
    return this.session.tokens?.accessToken ?? null;
  }

  /**
   * Subscribe to authentication events
   */
  public onAuthEvent(listener: AuthEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Refresh authentication tokens
   */
  public async refreshTokens(): Promise<boolean> {
    if (!this.session.tokens?.refreshToken) {
      this.log.warn('No refresh token available');
      return false;
    }

    this.log.info('Refreshing tokens');

    try {
      // TODO: [ ] Replace with actual API call
      const newTokens = await this.performTokenRefresh(this.session.tokens.refreshToken);
      
      if (newTokens) {
        this.session.tokens = newTokens;
        this.session.lastRefreshedAt = new Date().toISOString();
        
        await this.persistSession();
        this.scheduleTokenRefresh();
        this.notifyListeners('refresh');
        
        this.log.info('Tokens refreshed successfully');
        return true;
      }
      
      this.log.warn('Token refresh failed');
      await this.clearSession();
      this.notifyListeners('expired');
      return false;
    } catch (error) {
      this.log.error('Token refresh error', error as Error);
      await this.clearSession();
      this.notifyListeners('expired');
      return false;
    }
  }

  /**
   * Load session from secure storage
   */
  private async loadSession(): Promise<void> {
    this.log.debug('Loading session from storage');

    try {
      const accessToken = await this.context.secrets.get(STORAGE_KEYS.SESSION_TOKEN);
      const refreshToken = await this.context.secrets.get(STORAGE_KEYS.REFRESH_TOKEN);
      const profileJson = this.context.globalState.get<string>(STORAGE_KEYS.USER_PROFILE);

      if (accessToken && refreshToken && profileJson) {
        const profile = JSON.parse(profileJson) as UserProfile;
        
        // TODO: [ ] Session encryption - decrypt stored data
        this.session = {
          isAuthenticated: true,
          profile,
          tokens: {
            accessToken,
            refreshToken,
            // Calculate expiration based on token (JWT decode)
            expiresAt: this.calculateTokenExpiration(accessToken),
          },
          createdAt: new Date().toISOString(),
          lastRefreshedAt: new Date().toISOString(),
        };
        
        this.log.info('Session loaded from storage', { userId: profile.id });
      }
    } catch (error) {
      this.log.error('Failed to load session', error as Error);
      throw error;
    }
  }

  /**
   * Persist session to secure storage
   */
  private async persistSession(): Promise<void> {
    this.log.debug('Persisting session to storage');

    try {
      if (this.session.tokens) {
        // TODO: [ ] Session encryption - encrypt before storing
        await this.context.secrets.store(
          STORAGE_KEYS.SESSION_TOKEN, 
          this.session.tokens.accessToken
        );
        await this.context.secrets.store(
          STORAGE_KEYS.REFRESH_TOKEN, 
          this.session.tokens.refreshToken
        );
      }

      if (this.session.profile) {
        await this.context.globalState.update(
          STORAGE_KEYS.USER_PROFILE,
          JSON.stringify(this.session.profile)
        );
      }
    } catch (error) {
      this.log.error('Failed to persist session', error as Error);
      throw error;
    }
  }

  /**
   * Clear session from memory and storage
   */
  private async clearSession(): Promise<void> {
    this.log.debug('Clearing session');

    this.session = createEmptySession();
    
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    try {
      await this.context.secrets.delete(STORAGE_KEYS.SESSION_TOKEN);
      await this.context.secrets.delete(STORAGE_KEYS.REFRESH_TOKEN);
      await this.context.globalState.update(STORAGE_KEYS.USER_PROFILE, undefined);
    } catch (error) {
      this.log.error('Failed to clear session storage', error as Error);
    }
  }

  /**
   * Schedule automatic token refresh
   */
  private scheduleTokenRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }

    if (!this.session.tokens) {
      return;
    }

    const expiresAt = new Date(this.session.tokens.expiresAt);
    const now = new Date();
    const timeUntilExpiry = expiresAt.getTime() - now.getTime();
    
    // Refresh 5 minutes before expiration
    const refreshIn = Math.max(timeUntilExpiry - 5 * 60 * 1000, 0);

    this.log.debug('Scheduling token refresh', { 
      refreshInMs: refreshIn,
      expiresAt: this.session.tokens.expiresAt 
    });

    this.refreshTimer = setTimeout(async () => {
      await this.refreshTokens();
    }, refreshIn);
  }

  /**
   * Notify all listeners of an auth event
   */
  private notifyListeners(event: AuthEventType): void {
    const sessionCopy = { ...this.session };
    this.listeners.forEach(listener => {
      try {
        listener(event, sessionCopy);
      } catch (error) {
        this.log.error('Auth event listener error', error as Error);
      }
    });
  }

  /**
   * Parse backend expiresIn (e.g. "1h", "30m") to milliseconds
   */
  private static parseExpirationToMs(expiresIn: string): number {
    const match = /^(\d+)([smhd])?$/.exec(expiresIn.trim().toLowerCase());
    if (!match) return DEFAULTS.SESSION_TIMEOUT_MS;
    const value = parseInt(match[1], 10);
    const unit = match[2] || 's';
    const multipliers: Record<string, number> = { s: 1000, m: 60 * 1000, h: 3600 * 1000, d: 86400 * 1000 };
    return value * (multipliers[unit] ?? 1000);
  }

  /**
   * Calculate token expiration from JWT
   * TODO: [ ] Implement proper JWT decoding
   */
  private calculateTokenExpiration(token: string): string {
    // Placeholder: assume 1 hour expiration
    // TODO: Decode JWT and extract exp claim
    const expiration = new Date();
    expiration.setTime(expiration.getTime() + DEFAULTS.SESSION_TIMEOUT_MS);
    return expiration.toISOString();
  }

  /**
   * Perform login via backend dev-token API (production-ready).
   * POST /api/v1/auth/dev-token with { userId, email, displayName }.
   */
  private async performLogin(credentials: LoginCredentials): Promise<LoginResponse> {
    const config = vscode.workspace.getConfiguration();
    const serverUrl = config.get<string>(CONFIG_KEYS.SERVER_URL, DEFAULTS.SERVER_URL);
    const baseUrl = serverUrl.replace(/\/$/, '');
    const userId = 'user_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

    try {
      const response = await fetch(`${baseUrl}/api/v1/auth/dev-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          email: credentials.email,
          displayName: credentials.displayName,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        this.log.warn('Dev-token request failed', { status: response.status, body: text });
        return { success: false, error: text || 'Authentication failed' };
      }

      const data = (await response.json()) as { token: string; expiresIn: string };
      const expiresInMs = AuthService.parseExpirationToMs(data.expiresIn);

      return {
        success: true,
        tokens: {
          accessToken: data.token,
          refreshToken: data.token,
          expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        },
        profile: {
          id: userId,
          displayName: credentials.displayName,
          email: credentials.email,
          role: 'fullstack',
          status: 'online',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.error('Login request failed', new Error(msg));
      return { success: false, error: msg };
    }
  }

  /**
   * Perform logout (local only; backend dev-token has no server-side logout).
   */
  private async performLogout(): Promise<void> {
    // No server call for dev-token; session is client-only.
  }

  /**
   * Perform token refresh by re-issuing dev-token (same credentials from profile).
   */
  private async performTokenRefresh(_refreshToken: string): Promise<AuthTokens | null> {
    if (!this.session.profile) return null;
    const response = await this.performLogin({
      email: this.session.profile.email,
      displayName: this.session.profile.displayName,
    });
    if (response.success && response.tokens) return response.tokens;
    return null;
  }

  /**
   * Dispose of service resources
   */
  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.listeners.clear();
  }
}
