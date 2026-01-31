/**
 * PeerSync Dev Connect - WebSocket Peer Protocol
 * 
 * Real WebSocket implementation connecting to the NestJS backend.
 * Handles authentication, peer discovery, sessions, and message routing.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { CONFIG_KEYS, DEFAULTS, CONNECTION_STATE, type ConnectionState } from '../utils/constants';
import type { Peer, UserProfile, ConnectionRequest, Message } from '../models/session';

// ═══════════════════════════════════════════════════════════════════════════════
// BACKEND EVENT TYPES (must match peer-sync-backend exactly)
// ═══════════════════════════════════════════════════════════════════════════════

export const WsEvents = {
  // Authentication
  AUTH: 'AUTH',
  AUTH_SUCCESS: 'AUTH_SUCCESS',
  AUTH_FAILED: 'AUTH_FAILED',

  // Peer Events
  PEER_REGISTER: 'PEER_REGISTER',
  PEER_REGISTERED: 'PEER_REGISTERED',
  PEER_STATUS_UPDATE: 'PEER_STATUS_UPDATE',
  PEER_DISCONNECTED: 'PEER_DISCONNECTED',

  // Discovery
  DISCOVER_PEERS: 'DISCOVER_PEERS',
  PEERS_LIST: 'PEERS_LIST',

  // Connection Request Flow
  CONNECTION_REQUEST: 'CONNECTION_REQUEST',
  CONNECTION_REQUEST_RECEIVED: 'CONNECTION_REQUEST_RECEIVED',
  CONNECTION_RESPONSE: 'CONNECTION_RESPONSE',
  CONNECTION_ACCEPTED: 'CONNECTION_ACCEPTED',
  CONNECTION_REJECTED: 'CONNECTION_REJECTED',

  // Session Events
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_ENDED: 'SESSION_ENDED',

  // Messaging
  SEND_MESSAGE: 'SEND_MESSAGE',
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',

  // System
  ERROR: 'ERROR',
  PING: 'PING',
  PONG: 'PONG',
} as const;

export type WsEvent = (typeof WsEvents)[keyof typeof WsEvents];

// ═══════════════════════════════════════════════════════════════════════════════
// PAYLOAD INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AuthPayload {
  token: string;
}

export interface AuthSuccessPayload {
  userId: string;
  displayName: string;
  email: string;
}

export interface AuthFailedPayload {
  code: string;
  message: string;
}

export interface PeerRegisterPayload {
  displayName: string;
  ide: string;
  role?: string;
}

export interface PeerProfile {
  displayName: string;
  role: string;
  ide: string;
}

export interface PeerInfo {
  id: string;
  profile?: PeerProfile;
  status?: string;
  // ═══════════════════════════════════════════════════════════════════════════
  // LAN MODE ADDITION – SAFE EXTENSION
  // ═══════════════════════════════════════════════════════════════════════════
  /** Connection mode relative to requester (LAN = same network) */
  connectionMode?: 'LAN' | 'REMOTE';
  // ═══════════════════════════════════════════════════════════════════════════
}

export interface PeersListPayload {
  peers: PeerInfo[];
}

export interface ConnectionRequestReceivedPayload {
  requestId: string;
  from: PeerInfo;
}

export interface ConnectionAcceptedPayload {
  requestId: string;
  sessionId: string;
  peer: PeerInfo;
}

export interface ConnectionRejectedPayload {
  requestId: string;
  targetId: string;
}

export interface SessionCreatedPayload {
  sessionId: string;
  peer: PeerInfo;
}

export interface MessageReceivedPayload {
  sessionId: string;
  from: string;
  content: unknown;
  type?: string;
  correlationId?: string;
  timestamp: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROTOCOL EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════════════════════

export type ProtocolEventType =
  | 'connected'
  | 'disconnected'
  | 'authenticated'
  | 'auth_failed'
  | 'peer_registered'
  | 'peers_list'
  | 'peer_status_update'
  | 'connection_request_received'
  | 'connection_accepted'
  | 'connection_rejected'
  | 'session_created'
  | 'session_ended'
  | 'message_received'
  | 'error';

export type ProtocolEventListener = (
  event: ProtocolEventType,
  data: unknown
) => void;

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET PEER PROTOCOL
// ═══════════════════════════════════════════════════════════════════════════════

export class WebSocketPeerProtocol {
  private readonly log = logger.createChildLogger('WebSocketProtocol');
  
  private socket: WebSocket | null = null;
  private connectionState: ConnectionState = CONNECTION_STATE.DISCONNECTED;
  private isAuthenticated = false;
  private userId: string | null = null;
  private currentSessionId: string | null = null;
  
  // Reconnection
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly maxReconnectAttempts = DEFAULTS.MAX_RECONNECT_ATTEMPTS;
  private readonly reconnectIntervalMs = DEFAULTS.RECONNECT_INTERVAL_MS;
  
  // Heartbeat
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly pingIntervalMs = 25000;
  private lastPongTime = 0;
  
  // Event listeners
  private readonly listeners: Set<ProtocolEventListener> = new Set();
  
  // Pending connection requests (requestId -> callback)
  private readonly pendingConnectionRequests: Map<string, {
    resolve: (sessionId: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  constructor() {
    this.log.info('WebSocketPeerProtocol initialized');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONNECTION MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Connect to the backend WebSocket server
   */
  public async connect(): Promise<boolean> {
    if (this.connectionState === CONNECTION_STATE.CONNECTED) {
      this.log.info('Already connected');
      return true;
    }

    if (this.connectionState === CONNECTION_STATE.CONNECTING) {
      this.log.info('Connection in progress');
      return false;
    }

    this.setConnectionState(CONNECTION_STATE.CONNECTING);

    const serverUrl = this.getServerUrl();
    this.log.info('Connecting to WebSocket server', { url: serverUrl });

    return new Promise((resolve) => {
      try {
        this.socket = new WebSocket(serverUrl);

        this.socket.onopen = () => {
          this.log.info('WebSocket connected');
          this.setConnectionState(CONNECTION_STATE.CONNECTED);
          this.reconnectAttempts = 0;
          this.notifyListeners('connected', {});
          resolve(true);
        };

        this.socket.onclose = (event) => {
          this.log.info('WebSocket closed', { code: event.code, reason: event.reason });
          this.handleDisconnect();
          resolve(false);
        };

        this.socket.onerror = (event) => {
          this.log.error('WebSocket error', new Error('WebSocket connection error'));
          this.setConnectionState(CONNECTION_STATE.ERROR);
          resolve(false);
        };

        this.socket.onmessage = (event) => {
          this.handleMessage(event.data as string);
        };
      } catch (error) {
        this.log.error('Failed to create WebSocket', error as Error);
        this.setConnectionState(CONNECTION_STATE.ERROR);
        resolve(false);
      }
    });
  }

  /**
   * Disconnect from the server
   */
  public disconnect(): void {
    this.log.info('Disconnecting');
    
    this.clearTimers();
    this.isAuthenticated = false;
    this.userId = null;
    this.currentSessionId = null;

    if (this.socket) {
      this.socket.close(1000, 'User disconnected');
      this.socket = null;
    }

    this.setConnectionState(CONNECTION_STATE.DISCONNECTED);
    this.notifyListeners('disconnected', {});
  }

  /**
   * Handle disconnect and attempt reconnection
   */
  private handleDisconnect(): void {
    this.clearTimers();
    this.isAuthenticated = false;
    this.socket = null;
    
    this.setConnectionState(CONNECTION_STATE.DISCONNECTED);
    this.notifyListeners('disconnected', {});

    // Attempt reconnection
    this.scheduleReconnect();
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log.warn('Max reconnect attempts reached');
      this.setConnectionState(CONNECTION_STATE.ERROR);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectIntervalMs * Math.pow(2, this.reconnectAttempts - 1);
    
    this.log.info('Scheduling reconnect', { attempt: this.reconnectAttempts, delayMs: delay });
    this.setConnectionState(CONNECTION_STATE.RECONNECTING);

    this.reconnectTimer = setTimeout(async () => {
      await this.connect();
    }, delay);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Authenticate with the backend (MUST be called immediately after connect)
   */
  public async authenticate(token: string): Promise<boolean> {
    if (!this.isConnected()) {
      this.log.warn('Cannot authenticate - not connected');
      return false;
    }

    if (this.isAuthenticated) {
      this.log.info('Already authenticated');
      return true;
    }

    this.log.info('Authenticating');

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.log.warn('Authentication timeout');
        resolve(false);
      }, 10000);

      const authListener = (event: ProtocolEventType, data: unknown) => {
        if (event === 'authenticated') {
          clearTimeout(timeout);
          this.listeners.delete(authListener);
          resolve(true);
        } else if (event === 'auth_failed') {
          clearTimeout(timeout);
          this.listeners.delete(authListener);
          resolve(false);
        }
      };

      this.listeners.add(authListener);
      this.send(WsEvents.AUTH, { token });
    });
  }

  /**
   * Register as a peer after authentication
   */
  public registerPeer(displayName: string, ide: string, role?: string): void {
    if (!this.isAuthenticated) {
      this.log.warn('Cannot register - not authenticated');
      return;
    }

    this.send(WsEvents.PEER_REGISTER, { displayName, ide, role });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PEER DISCOVERY
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Request list of available peers
   * 
   * @param filters - Optional filters for peer discovery
   * @param filters.role - Filter by peer role
   * @param filters.ide - Filter by IDE type
   * @param filters.lanOnly - LAN MODE ADDITION: Return only peers on same network
   */
  public discoverPeers(filters?: { role?: string; ide?: string; lanOnly?: boolean }): void {
    if (!this.isAuthenticated) {
      this.log.warn('Cannot discover peers - not authenticated');
      return;
    }

    this.send(WsEvents.DISCOVER_PEERS, filters || {});
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONNECTION REQUESTS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send connection request to a peer
   */
  public async sendConnectionRequest(targetId: string): Promise<string> {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated');
    }

    this.log.info('Sending connection request', { targetId });
    this.send(WsEvents.CONNECTION_REQUEST, { targetId });

    // Return immediately - session will be created when accepted
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingConnectionRequests.delete(targetId);
        reject(new Error('Connection request timeout'));
      }, 60000);

      this.pendingConnectionRequests.set(targetId, { resolve, reject, timeout });
    });
  }

  /**
   * Respond to a connection request
   */
  public respondToConnectionRequest(requestId: string, accepted: boolean): void {
    if (!this.isAuthenticated) {
      this.log.warn('Cannot respond - not authenticated');
      return;
    }

    this.log.info('Responding to connection request', { requestId, accepted });
    this.send(WsEvents.CONNECTION_RESPONSE, { requestId, accepted });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message within a session
   */
  public sendMessage(
    sessionId: string,
    content: unknown,
    type?: string,
    correlationId?: string
  ): void {
    if (!this.isAuthenticated) {
      this.log.warn('Cannot send message - not authenticated');
      return;
    }

    if (!sessionId) {
      this.log.warn('Cannot send message - no sessionId');
      return;
    }

    this.log.debug('Sending message', { sessionId, type });

    this.send(WsEvents.SEND_MESSAGE, {
      sessionId,
      content,
      type,
      correlationId,
    });
  }

  /**
   * Get current session ID
   */
  public getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Set current session ID
   */
  public setCurrentSessionId(sessionId: string | null): void {
    this.currentSessionId = sessionId;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEARTBEAT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start heartbeat/ping interval
   */
  public startHeartbeat(): void {
    this.clearTimers();
    
    this.pingTimer = setInterval(() => {
      if (this.isConnected() && this.isAuthenticated) {
        this.send(WsEvents.PING, {});
      }
    }, this.pingIntervalMs);
  }

  /**
   * Send ping manually
   */
  public ping(): void {
    if (this.isConnected()) {
      this.send(WsEvents.PING, {});
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESSAGE HANDLING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(raw: string): void {
    let message: { event: string; data: unknown };

    try {
      message = JSON.parse(raw) as { event: string; data: unknown };
    } catch {
      this.log.warn('Failed to parse message', { raw });
      return;
    }

    const { event, data } = message;
    this.log.debug('Received event', { event });

    switch (event) {
      case WsEvents.AUTH_SUCCESS:
        this.handleAuthSuccess(data as AuthSuccessPayload);
        break;

      case WsEvents.AUTH_FAILED:
        this.handleAuthFailed(data as AuthFailedPayload);
        break;

      case WsEvents.PEER_REGISTERED:
        this.notifyListeners('peer_registered', data);
        break;

      case WsEvents.PEERS_LIST:
        this.notifyListeners('peers_list', data);
        break;

      case WsEvents.PEER_STATUS_UPDATE:
        this.notifyListeners('peer_status_update', data);
        break;

      case WsEvents.CONNECTION_REQUEST_RECEIVED:
        this.notifyListeners('connection_request_received', data);
        break;

      case WsEvents.CONNECTION_ACCEPTED:
        this.handleConnectionAccepted(data as ConnectionAcceptedPayload);
        break;

      case WsEvents.CONNECTION_REJECTED:
        this.handleConnectionRejected(data as ConnectionRejectedPayload);
        break;

      case WsEvents.SESSION_CREATED:
        this.handleSessionCreated(data as SessionCreatedPayload);
        break;

      case WsEvents.SESSION_ENDED:
        this.notifyListeners('session_ended', data);
        this.currentSessionId = null;
        break;

      case WsEvents.MESSAGE_RECEIVED:
        this.notifyListeners('message_received', data);
        break;

      case WsEvents.PONG:
        this.lastPongTime = Date.now();
        break;

      case WsEvents.ERROR:
        this.handleError(data as ErrorPayload);
        break;

      default:
        this.log.debug('Unknown event', { event });
    }
  }

  private handleAuthSuccess(data: AuthSuccessPayload): void {
    this.isAuthenticated = true;
    this.userId = data.userId;
    this.log.info('Authentication successful', { userId: data.userId });
    this.startHeartbeat();
    this.notifyListeners('authenticated', data);
  }

  private handleAuthFailed(data: AuthFailedPayload): void {
    this.isAuthenticated = false;
    this.log.warn('Authentication failed', { code: data.code, message: data.message });
    this.notifyListeners('auth_failed', data);
    
    // Close socket on auth failure
    this.disconnect();
  }

  private handleConnectionAccepted(data: ConnectionAcceptedPayload): void {
    this.log.info('Connection accepted', { sessionId: data.sessionId });
    this.currentSessionId = data.sessionId;

    // Resolve pending request if any
    // Find by peer ID (we stored targetId as key)
    for (const [key, pending] of this.pendingConnectionRequests) {
      if (data.peer?.id === key || data.requestId) {
        clearTimeout(pending.timeout);
        pending.resolve(data.sessionId);
        this.pendingConnectionRequests.delete(key);
        break;
      }
    }

    this.notifyListeners('connection_accepted', data);
  }

  private handleConnectionRejected(data: ConnectionRejectedPayload): void {
    this.log.info('Connection rejected', { targetId: data.targetId });

    // Reject pending request
    const pending = this.pendingConnectionRequests.get(data.targetId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection request rejected'));
      this.pendingConnectionRequests.delete(data.targetId);
    }

    this.notifyListeners('connection_rejected', data);
  }

  private handleSessionCreated(data: SessionCreatedPayload): void {
    this.log.info('Session created', { sessionId: data.sessionId });
    this.currentSessionId = data.sessionId;
    this.notifyListeners('session_created', data);
  }

  private handleError(data: ErrorPayload): void {
    this.log.warn('Server error', { code: data.code, message: data.message });
    this.notifyListeners('error', data);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Send event to server
   */
  private send(event: string, data: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.log.warn('Cannot send - socket not open', { event });
      return;
    }

    const message = JSON.stringify({ event, data });
    this.socket.send(message);
  }

  /**
   * Get WebSocket server URL
   */
  private getServerUrl(): string {
    const config = vscode.workspace.getConfiguration();
    const httpUrl = config.get<string>(CONFIG_KEYS.SERVER_URL, DEFAULTS.SERVER_URL);
    
    // Convert HTTP URL to WebSocket URL
    const wsUrl = httpUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://');
    
    return `${wsUrl}/ws`;
  }

  /**
   * Check if connected
   */
  public isConnected(): boolean {
    return this.socket !== null && 
           this.socket.readyState === WebSocket.OPEN &&
           this.connectionState === CONNECTION_STATE.CONNECTED;
  }

  /**
   * Check if authenticated
   */
  public isAuthenticatedState(): boolean {
    return this.isAuthenticated;
  }

  /**
   * Get current connection state
   */
  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Get current user ID
   */
  public getUserId(): string | null {
    return this.userId;
  }

  /**
   * Set connection state and log
   */
  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.log.debug('Connection state changed', { state });
  }

  /**
   * Clear all timers
   */
  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT LISTENERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to protocol events
   */
  public onEvent(listener: ProtocolEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Notify all listeners
   */
  private notifyListeners(event: ProtocolEventType, data: unknown): void {
    this.listeners.forEach(listener => {
      try {
        listener(event, data);
      } catch (error) {
        this.log.error('Event listener error', error as Error);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DISPOSAL
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.disconnect();
    this.listeners.clear();
    this.pendingConnectionRequests.forEach(pending => {
      clearTimeout(pending.timeout);
    });
    this.pendingConnectionRequests.clear();
  }
}

// Export singleton instance
let protocolInstance: WebSocketPeerProtocol | null = null;

export function getWebSocketProtocol(): WebSocketPeerProtocol {
  if (!protocolInstance) {
    protocolInstance = new WebSocketPeerProtocol();
  }
  return protocolInstance;
}

export function disposeWebSocketProtocol(): void {
  if (protocolInstance) {
    protocolInstance.dispose();
    protocolInstance = null;
  }
}
