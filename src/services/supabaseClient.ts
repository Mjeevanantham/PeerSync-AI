/**
 * PeerSync Dev Connect - Supabase Client
 * 
 * Handles Supabase authentication with browser-based OAuth flow.
 * Manages session tokens securely using VS Code SecretStorage.
 */

import * as vscode from 'vscode';
import { createClient, type SupabaseClient, type Session, type User, type AuthChangeEvent } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { 
  SUPABASE_CONFIG, 
  CONFIG_KEYS, 
  STORAGE_KEYS 
} from '../utils/constants';

const log = logger.createChildLogger('SupabaseClient');

/**
 * Supabase session data for secure storage
 */
interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: {
    id: string;
    email?: string;
    user_metadata?: {
      full_name?: string;
      name?: string;
      avatar_url?: string;
      preferred_username?: string;
    };
  };
}

/**
 * OAuth provider types supported
 */
export type OAuthProvider = 'github' | 'google' | 'azure';

/**
 * Auth state change callback
 */
export type AuthStateCallback = (event: AuthChangeEvent, session: Session | null) => void;

/**
 * Supabase Client Manager
 * 
 * Singleton that manages Supabase client initialization and OAuth flow.
 */
export class SupabaseClientManager {
  private static instance: SupabaseClientManager | null = null;
  private client: SupabaseClient | null = null;
  private context: vscode.ExtensionContext | null = null;
  private pendingAuthCallback: ((session: Session | null) => void) | null = null;
  private authStateCallbacks: Set<AuthStateCallback> = new Set();
  private uriHandler: vscode.Disposable | null = null;

  private constructor() {}

  /**
   * Get the singleton instance
   */
  public static getInstance(): SupabaseClientManager {
    if (!SupabaseClientManager.instance) {
      SupabaseClientManager.instance = new SupabaseClientManager();
    }
    return SupabaseClientManager.instance;
  }

  /**
   * Initialize the Supabase client with VS Code context
   */
  public async initialize(context: vscode.ExtensionContext): Promise<void> {
    this.context = context;

    const config = vscode.workspace.getConfiguration();
    const supabaseUrl = config.get<string>(CONFIG_KEYS.SUPABASE_URL) || SUPABASE_CONFIG.URL;
    const supabaseAnonKey = config.get<string>(CONFIG_KEYS.SUPABASE_ANON_KEY) || SUPABASE_CONFIG.ANON_KEY;

    if (supabaseUrl === 'https://your-project.supabase.co' || supabaseAnonKey === 'your-anon-key') {
      log.warn('Supabase configuration not set. Please configure peerSync.supabaseUrl and peerSync.supabaseAnonKey in settings.');
    }

    this.client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false, // We handle persistence manually with SecretStorage
        autoRefreshToken: false, // We handle refresh manually
        detectSessionInUrl: false, // VS Code handles URL callbacks
      },
    });

    // Register URI handler for OAuth callback
    this.registerUriHandler();

    // Try to restore session from secure storage
    await this.restoreSession();

    // Listen for auth state changes
    this.client.auth.onAuthStateChange((event, session) => {
      log.info('Auth state changed', { event, hasSession: !!session });
      this.notifyAuthStateCallbacks(event, session);
      
      if (session) {
        this.persistSession(session);
      }
    });

    log.info('Supabase client initialized');
  }

  /**
   * Register URI handler for OAuth callback
   */
  private registerUriHandler(): void {
    if (!this.context) return;

    this.uriHandler = vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri) => {
        log.info('Received URI callback', { path: uri.path, query: uri.query });
        await this.handleOAuthCallback(uri);
      },
    });

    this.context.subscriptions.push(this.uriHandler);
    log.info('URI handler registered for OAuth callback');
  }

  /**
   * Handle OAuth callback URI
   */
  private async handleOAuthCallback(uri: vscode.Uri): Promise<void> {
    try {
      // Parse the callback URL for tokens
      const params = new URLSearchParams(uri.query);
      const fragment = uri.fragment;
      
      // Supabase may return tokens in fragment (hash) or query params
      let accessToken = params.get('access_token');
      let refreshToken = params.get('refresh_token');
      
      // Try parsing fragment if tokens not in query
      if (!accessToken && fragment) {
        const fragmentParams = new URLSearchParams(fragment);
        accessToken = fragmentParams.get('access_token');
        refreshToken = fragmentParams.get('refresh_token');
      }

      if (!accessToken) {
        // Check for error
        const error = params.get('error') || params.get('error_description');
        if (error) {
          log.error('OAuth error', new Error(error));
          vscode.window.showErrorMessage(`Authentication failed: ${error}`);
          this.pendingAuthCallback?.(null);
          return;
        }

        // May be a code flow - exchange code for session
        const code = params.get('code');
        if (code && this.client) {
          log.info('Exchanging code for session');
          const { data, error: exchangeError } = await this.client.auth.exchangeCodeForSession(code);
          
          if (exchangeError) {
            log.error('Code exchange failed', exchangeError);
            vscode.window.showErrorMessage(`Authentication failed: ${exchangeError.message}`);
            this.pendingAuthCallback?.(null);
            return;
          }

          if (data.session) {
            await this.persistSession(data.session);
            this.pendingAuthCallback?.(data.session);
            vscode.window.showInformationMessage('Successfully signed in with GitHub!');
          }
          return;
        }

        log.warn('No tokens or code in callback');
        this.pendingAuthCallback?.(null);
        return;
      }

      // Set session directly if tokens are present
      if (this.client && accessToken && refreshToken) {
        const { data, error } = await this.client.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });

        if (error) {
          log.error('Failed to set session', error);
          vscode.window.showErrorMessage(`Authentication failed: ${error.message}`);
          this.pendingAuthCallback?.(null);
          return;
        }

        if (data.session) {
          await this.persistSession(data.session);
          this.pendingAuthCallback?.(data.session);
          vscode.window.showInformationMessage('Successfully signed in with GitHub!');
        }
      }
    } catch (error) {
      log.error('OAuth callback handling failed', error as Error);
      vscode.window.showErrorMessage(`Authentication failed: ${(error as Error).message}`);
      this.pendingAuthCallback?.(null);
    }
  }

  /**
   * Get URI scheme for current IDE (vscode, cursor, windsurf, antigravity, code)
   * Add redirect URLs for all supported IDEs in Supabase Dashboard.
   */
  private getUriSchemeForIde(): string {
    // vscode.env.uriScheme - primary source (VS Code 1.74+)
    if (typeof vscode.env.uriScheme === 'string' && vscode.env.uriScheme) {
      return vscode.env.uriScheme;
    }
    // Fallback: detect by app name for IDEs that don't expose uriScheme
    const appName = typeof vscode.env.appName === 'string' ? vscode.env.appName.toLowerCase() : '';
    if (appName.includes('cursor')) return 'cursor';
    if (appName.includes('windsurf')) return 'windsurf';
    if (appName.includes('antigravity')) return 'antigravity';
    if (appName.includes('code - oss') || appName.includes('vscodium')) return 'code';
    return SUPABASE_CONFIG.REDIRECT_SCHEME;
  }

  /**
   * Sign in with OAuth provider (opens browser)
   */
  public async signInWithOAuth(provider: OAuthProvider): Promise<Session | null> {
    if (!this.client) {
      log.error('Supabase client not initialized');
      return null;
    }

    return new Promise(async (resolve) => {
      try {
        // Set up callback handler
        this.pendingAuthCallback = resolve;

        // Build redirect URL - use current IDE's URI scheme for multi-IDE support
        // Supported: VS Code, Cursor, Windsurf, Antigravity, Code - OSS
        const scheme = this.getUriSchemeForIde();
        const redirectUri = `${scheme}://${SUPABASE_CONFIG.EXTENSION_ID}/auth/callback`;

        log.info('Starting OAuth flow', { provider, redirectUri, scheme });

        // Get OAuth URL from Supabase
        const { data, error } = await this.client!.auth.signInWithOAuth({
          provider,
          options: {
            redirectTo: redirectUri,
            skipBrowserRedirect: true, // We handle browser opening ourselves
          },
        });

        if (error) {
          log.error('OAuth initiation failed', error);
          vscode.window.showErrorMessage(`Failed to start authentication: ${error.message}`);
          resolve(null);
          return;
        }

        if (data.url) {
          // Open the auth URL in the default browser
          const opened = await vscode.env.openExternal(vscode.Uri.parse(data.url));
          
          if (!opened) {
            log.error('Failed to open browser');
            vscode.window.showErrorMessage('Failed to open browser for authentication');
            resolve(null);
            return;
          }

          log.info('Browser opened for OAuth');
          
          // Set a timeout for the auth flow
          setTimeout(() => {
            if (this.pendingAuthCallback === resolve) {
              log.warn('OAuth timeout');
              this.pendingAuthCallback = null;
              resolve(null);
            }
          }, 5 * 60 * 1000); // 5 minute timeout
        }
      } catch (error) {
        log.error('OAuth sign in failed', error as Error);
        resolve(null);
      }
    });
  }

  /**
   * Sign out the current user
   */
  public async signOut(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.auth.signOut();
      await this.clearStoredSession();
      log.info('Signed out successfully');
    } catch (error) {
      log.error('Sign out failed', error as Error);
      // Clear local session anyway
      await this.clearStoredSession();
    }
  }

  /**
   * Get current session (from memory or storage)
   */
  public async getSession(): Promise<Session | null> {
    if (!this.client) return null;

    const { data: { session } } = await this.client.auth.getSession();
    
    if (session) {
      return session;
    }

    // Try to restore from storage
    return await this.restoreSession();
  }

  /**
   * Get current user
   */
  public async getUser(): Promise<User | null> {
    if (!this.client) return null;

    const { data: { user } } = await this.client.auth.getUser();
    return user;
  }

  /**
   * Get access token for WebSocket AUTH
   */
  public async getAccessToken(): Promise<string | null> {
    const session = await this.getSession();
    return session?.access_token ?? null;
  }

  /**
   * Refresh the current session
   */
  public async refreshSession(): Promise<Session | null> {
    if (!this.client) return null;

    try {
      const { data, error } = await this.client.auth.refreshSession();
      
      if (error) {
        log.error('Session refresh failed', error);
        await this.clearStoredSession();
        return null;
      }

      if (data.session) {
        await this.persistSession(data.session);
        return data.session;
      }

      return null;
    } catch (error) {
      log.error('Session refresh error', error as Error);
      return null;
    }
  }

  /**
   * Check if session is expired
   */
  public isSessionExpired(session: Session): boolean {
    if (!session.expires_at) return true;
    
    // Consider expired 5 minutes before actual expiry
    const bufferMs = 5 * 60 * 1000;
    const expiresAt = session.expires_at * 1000; // Convert to milliseconds
    return Date.now() >= expiresAt - bufferMs;
  }

  /**
   * Subscribe to auth state changes
   */
  public onAuthStateChange(callback: AuthStateCallback): vscode.Disposable {
    this.authStateCallbacks.add(callback);
    return new vscode.Disposable(() => {
      this.authStateCallbacks.delete(callback);
    });
  }

  /**
   * Notify all auth state callbacks
   */
  private notifyAuthStateCallbacks(event: AuthChangeEvent, session: Session | null): void {
    this.authStateCallbacks.forEach(callback => {
      try {
        callback(event, session);
      } catch (error) {
        log.error('Auth state callback error', error as Error);
      }
    });
  }

  /**
   * Persist session to secure storage
   */
  private async persistSession(session: Session): Promise<void> {
    if (!this.context) return;

    try {
      const storedSession: StoredSession = {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user: {
          id: session.user.id,
          email: session.user.email,
          user_metadata: session.user.user_metadata,
        },
      };

      // Store tokens securely
      await this.context.secrets.store(
        STORAGE_KEYS.SESSION_TOKEN,
        session.access_token
      );
      await this.context.secrets.store(
        STORAGE_KEYS.REFRESH_TOKEN,
        session.refresh_token
      );
      
      // Store session metadata (non-sensitive)
      await this.context.secrets.store(
        STORAGE_KEYS.SUPABASE_SESSION,
        JSON.stringify(storedSession)
      );

      log.info('Session persisted to secure storage');
    } catch (error) {
      log.error('Failed to persist session', error as Error);
    }
  }

  /**
   * Restore session from secure storage
   */
  private async restoreSession(): Promise<Session | null> {
    if (!this.context || !this.client) return null;

    try {
      const storedSessionJson = await this.context.secrets.get(STORAGE_KEYS.SUPABASE_SESSION);
      
      if (!storedSessionJson) {
        log.debug('No stored session found');
        return null;
      }

      const storedSession: StoredSession = JSON.parse(storedSessionJson);

      // Set the session in Supabase client
      const { data, error } = await this.client.auth.setSession({
        access_token: storedSession.access_token,
        refresh_token: storedSession.refresh_token,
      });

      if (error) {
        log.warn('Failed to restore session', { error: error.message });
        await this.clearStoredSession();
        return null;
      }

      if (data.session) {
        // Check if session needs refresh
        if (this.isSessionExpired(data.session)) {
          log.info('Stored session expired, refreshing');
          return await this.refreshSession();
        }

        log.info('Session restored from storage', { userId: data.session.user.id });
        return data.session;
      }

      return null;
    } catch (error) {
      log.error('Failed to restore session', error as Error);
      await this.clearStoredSession();
      return null;
    }
  }

  /**
   * Clear stored session
   */
  private async clearStoredSession(): Promise<void> {
    if (!this.context) return;

    try {
      await this.context.secrets.delete(STORAGE_KEYS.SESSION_TOKEN);
      await this.context.secrets.delete(STORAGE_KEYS.REFRESH_TOKEN);
      await this.context.secrets.delete(STORAGE_KEYS.SUPABASE_SESSION);
      await this.context.globalState.update(STORAGE_KEYS.USER_PROFILE, undefined);
      log.info('Stored session cleared');
    } catch (error) {
      log.error('Failed to clear stored session', error as Error);
    }
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    if (this.uriHandler) {
      this.uriHandler.dispose();
    }
    this.authStateCallbacks.clear();
    this.client = null;
    this.context = null;
    SupabaseClientManager.instance = null;
  }
}

// Export singleton getter for convenience
export const getSupabaseManager = (): SupabaseClientManager => {
  return SupabaseClientManager.getInstance();
};
