/**
 * PeerSync Dev Connect - Authentication Service
 * 
 * Handles user authentication via Supabase OAuth, token management, and session persistence.
 * Uses browser-based GitHub OAuth flow for secure authentication.
 * Stores credentials securely using VS Code SecretStorage.
 */

import * as vscode from 'vscode';
import type { Session as SupabaseSession, AuthChangeEvent } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { 
  STORAGE_KEYS, 
  DEFAULTS 
} from '../utils/constants';
import type { 
  Session, 
  AuthTokens, 
  UserProfile 
} from '../models/session';
import { createEmptySession, areTokensExpired } from '../models/session';
import { 
  SupabaseClientManager, 
  getSupabaseManager,
  type OAuthProvider 
} from './supabaseClient';

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
 * Manages user authentication state using Supabase OAuth.
 * Provides secure token storage and automatic refresh.
 */
export class AuthService {
  private session: Session;
  private readonly context: vscode.ExtensionContext;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly listeners: Set<AuthEventListener> = new Set();
  private readonly log = logger.createChildLogger('AuthService');
  private supabaseManager: SupabaseClientManager;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.session = createEmptySession();
    this.supabaseManager = getSupabaseManager();
  }

  /**
   * Initialize the authentication service
   */
  public async initialize(): Promise<void> {
    this.log.info('Initializing authentication service with Supabase');
    
    try {
      // Initialize Supabase client
      await this.supabaseManager.initialize(this.context);

      // Subscribe to Supabase auth state changes
      this.supabaseManager.onAuthStateChange(this.handleSupabaseAuthChange.bind(this));

      // Try to restore existing session
      const supabaseSession = await this.supabaseManager.getSession();
      
      if (supabaseSession) {
        this.log.info('Existing Supabase session found');
        await this.updateSessionFromSupabase(supabaseSession);
        
        if (this.supabaseManager.isSessionExpired(supabaseSession)) {
          this.log.info('Session tokens expired, attempting refresh');
          await this.refreshTokens();
        } else {
          this.scheduleTokenRefresh();
        }
      } else {
        this.log.info('No existing session found');
      }
    } catch (error) {
      this.log.error('Failed to initialize auth service', error as Error);
      await this.clearSession();
    }
  }

  /**
   * Handle Supabase auth state changes
   */
  private async handleSupabaseAuthChange(event: AuthChangeEvent, supabaseSession: SupabaseSession | null): Promise<void> {
    this.log.info('Supabase auth state changed', { event });

    switch (event) {
      case 'SIGNED_IN':
        if (supabaseSession) {
          await this.updateSessionFromSupabase(supabaseSession);
          this.notifyListeners('login');
        }
        break;
      
      case 'SIGNED_OUT':
        await this.clearSession();
        this.notifyListeners('logout');
        break;
      
      case 'TOKEN_REFRESHED':
        if (supabaseSession) {
          await this.updateSessionFromSupabase(supabaseSession);
          this.notifyListeners('refresh');
        }
        break;
      
      case 'USER_UPDATED':
        if (supabaseSession) {
          await this.updateSessionFromSupabase(supabaseSession);
        }
        break;
    }
  }

  /**
   * Update local session from Supabase session
   */
  private async updateSessionFromSupabase(supabaseSession: SupabaseSession): Promise<void> {
    const user = supabaseSession.user;
    const metadata = user.user_metadata || {};

    // Extract display name from various possible sources
    const displayName = 
      metadata.full_name || 
      metadata.name || 
      metadata.preferred_username ||
      user.email?.split('@')[0] ||
      'Anonymous';

    // Extract avatar URL
    const avatarUrl = metadata.avatar_url || metadata.picture;

    const profile: UserProfile = {
      id: user.id,
      displayName,
      email: user.email || '',
      avatarUrl,
      role: 'fullstack', // Default role, can be updated by user
      status: 'online',
      createdAt: user.created_at || new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };

    const tokens: AuthTokens = {
      accessToken: supabaseSession.access_token,
      refreshToken: supabaseSession.refresh_token,
      expiresAt: supabaseSession.expires_at 
        ? new Date(supabaseSession.expires_at * 1000).toISOString()
        : new Date(Date.now() + DEFAULTS.SESSION_TIMEOUT_MS).toISOString(),
    };

    this.session = {
      isAuthenticated: true,
      profile,
      tokens,
      createdAt: new Date().toISOString(),
      lastRefreshedAt: new Date().toISOString(),
    };

    await this.persistSession();
    this.scheduleTokenRefresh();

    this.log.info('Session updated from Supabase', { userId: user.id, displayName });
  }

  /**
   * Login with OAuth provider (GitHub, Google, LinkedIn)
   */
  public async loginWithOAuth(provider: OAuthProvider = 'github'): Promise<boolean> {
    this.log.info('Starting OAuth login', { provider });
    
    try {
      const supabaseSession = await this.supabaseManager.signInWithOAuth(provider);
      
      if (supabaseSession) {
        await this.updateSessionFromSupabase(supabaseSession);
        this.notifyListeners('login');
        this.log.info('OAuth login successful', { userId: supabaseSession.user.id });
        return true;
      }
      
      this.log.warn('OAuth login failed - no session returned');
      return false;
    } catch (error) {
      this.log.error('OAuth login error', error as Error);
      throw error;
    }
  }

  /**
   * Login with email and password
   */
  public async loginWithEmailPassword(email: string, password: string): Promise<boolean> {
    this.log.info('Starting email/password login', { email });

    try {
      const supabaseSession = await this.supabaseManager.signInWithPassword(email, password);

      if (supabaseSession) {
        await this.updateSessionFromSupabase(supabaseSession);
        this.notifyListeners('login');
        this.log.info('Email/password login successful', { userId: supabaseSession.user.id });
        return true;
      }

      return false;
    } catch (error) {
      this.log.error('Email/password login error', error as Error);
      throw error;
    }
  }

  /**
   * Login with email OTP - Step 1: Request OTP
   */
  public async requestEmailOtp(email: string): Promise<{ success: boolean; error?: string }> {
    this.log.info('Requesting OTP', { email });

    try {
      const result = await this.supabaseManager.requestOtp(email);
      if (result.error) {
        return { success: false, error: result.error };
      }
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      this.log.error('OTP request error', error as Error);
      return { success: false, error: msg };
    }
  }

  /**
   * Login with email OTP - Step 2: Verify OTP
   */
  public async verifyEmailOtp(email: string, token: string): Promise<boolean> {
    this.log.info('Verifying OTP', { email });

    try {
      const supabaseSession = await this.supabaseManager.verifyOtp(email, token);

      if (supabaseSession) {
        await this.updateSessionFromSupabase(supabaseSession);
        this.notifyListeners('login');
        this.log.info('OTP login successful', { userId: supabaseSession.user.id });
        return true;
      }

      return false;
    } catch (error) {
      this.log.error('OTP verification error', error as Error);
      throw error;
    }
  }

  /**
   * Logout the current user
   */
  public async logout(): Promise<void> {
    this.log.info('Logging out user');
    
    try {
      await this.supabaseManager.signOut();
    } catch (error) {
      this.log.warn('Supabase logout failed', { error });
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
   * Get current access token (Supabase JWT)
   */
  public getAccessToken(): string | null {
    return this.session.tokens?.accessToken ?? null;
  }

  /**
   * Get access token async (refreshes if needed)
   */
  public async getAccessTokenAsync(): Promise<string | null> {
    if (!this.session.tokens) {
      return null;
    }

    // Check if token needs refresh
    if (areTokensExpired(this.session.tokens)) {
      this.log.info('Token expired, refreshing before use');
      const refreshed = await this.refreshTokens();
      if (!refreshed) {
        return null;
      }
    }

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
    if (!this.session.isAuthenticated) {
      this.log.warn('Cannot refresh - not authenticated');
      return false;
    }

    this.log.info('Refreshing tokens');

    try {
      const newSession = await this.supabaseManager.refreshSession();
      
      if (newSession) {
        await this.updateSessionFromSupabase(newSession);
        this.notifyListeners('refresh');
        this.log.info('Tokens refreshed successfully');
        return true;
      }
      
      this.log.warn('Token refresh failed - no session returned');
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
   * Persist session to secure storage
   */
  private async persistSession(): Promise<void> {
    this.log.debug('Persisting session to storage');

    try {
      // Profile is stored in globalState (non-sensitive)
      if (this.session.profile) {
        await this.context.globalState.update(
          STORAGE_KEYS.USER_PROFILE,
          JSON.stringify(this.session.profile)
        );
      }
      // Note: Tokens are persisted by SupabaseClientManager in secrets
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
      await this.context.secrets.delete(STORAGE_KEYS.SUPABASE_SESSION);
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
      const refreshed = await this.refreshTokens();
      if (!refreshed) {
        // Token refresh failed, notify user
        vscode.window.showWarningMessage(
          'Your session has expired. Please sign in again.',
          'Sign In'
        ).then(action => {
          if (action === 'Sign In') {
            vscode.commands.executeCommand('peerSync.connect');
          }
        });
      }
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
   * Dispose of service resources
   */
  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.listeners.clear();
    this.supabaseManager.dispose();
  }
}

// Re-export types for backward compatibility
export interface LoginCredentials {
  email: string;
  displayName: string;
}
