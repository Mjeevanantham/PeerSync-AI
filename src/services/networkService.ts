/**
 * PeerSync - Network Service (Invite-Code Discovery)
 *
 * Calls backend REST API for create/join/leave network.
 * All actions require Supabase JWT (Bearer token).
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { CONFIG_KEYS, DEFAULTS, API_ENDPOINTS } from '../utils/constants';
import { AuthService } from './authService';

const log = logger.createChildLogger('NetworkService');

export interface NetworkInfo {
  id: string;
  inviteCode: string;
  createdBy: string;
  createdAt: string;
}

/**
 * Network Service - create/join/leave network via backend API
 */
export class NetworkService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly authService: AuthService,
  ) {}

  private getServerUrl(): string {
    return vscode.workspace.getConfiguration().get<string>(CONFIG_KEYS.SERVER_URL, DEFAULTS.SERVER_URL) ?? DEFAULTS.SERVER_URL;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.authService.getAccessTokenAsync();
    if (!token) {
      throw new Error('Not authenticated');
    }
    const base = this.getServerUrl().replace(/\/$/, '');
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    const options: RequestInit = { method, headers };
    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    }
    log.debug('Network API request', { method, path });
    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        const j = JSON.parse(text);
        message = j.message ?? j.error ?? text;
      } catch {
        // use text as-is
      }
      throw new Error(message || `HTTP ${res.status}`);
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T;
    }
    return res.json() as Promise<T>;
  }

  async getActiveNetwork(): Promise<NetworkInfo | null> {
    if (!this.authService.isAuthenticated()) return null;
    try {
      const data = await this.request<NetworkInfo | null>('GET', API_ENDPOINTS.NETWORK_GET);
      return data ?? null;
    } catch (e) {
      log.warn('getActiveNetwork failed', { error: (e as Error).message });
      return null;
    }
  }

  async createNetwork(): Promise<NetworkInfo> {
    const data = await this.request<NetworkInfo>('POST', API_ENDPOINTS.NETWORK_CREATE);
    return data;
  }

  async joinNetwork(inviteCode: string): Promise<NetworkInfo> {
    const data = await this.request<NetworkInfo>('POST', API_ENDPOINTS.NETWORK_JOIN, {
      inviteCode: inviteCode.trim(),
    });
    return data;
  }

  async leaveNetwork(): Promise<void> {
    await this.request<{ left: boolean }>('POST', API_ENDPOINTS.NETWORK_LEAVE);
  }
}
