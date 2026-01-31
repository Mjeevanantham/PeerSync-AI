/**
 * WebSocket Peer Protocol - Production real-time backend connection
 *
 * Connects to PeerSync backend (wss://.../ws), handles AUTH, PEER_REGISTER,
 * DISCOVER_PEERS, CONNECTION_REQUEST/RESPONSE, SEND_MESSAGE, and events.
 * No mock data; all state comes from the backend.
 * 
 * Authentication: Uses Supabase access_token (JWT) for WebSocket AUTH.
 * The token is sent immediately after connection opens.
 * Auth failure codes: 4001 (invalid token), 4002 (token expired)
 */

import { logger } from '../utils/logger';

const log = logger.createChildLogger('WebSocketPeerProtocol');

/** Backend WebSocket event names */
export const WsEvents = {
  AUTH: 'AUTH',
  AUTH_SUCCESS: 'AUTH_SUCCESS',
  AUTH_FAILED: 'AUTH_FAILED',
  PEER_REGISTER: 'PEER_REGISTER',
  PEER_REGISTERED: 'PEER_REGISTERED',
  PEER_STATUS_UPDATE: 'PEER_STATUS_UPDATE',
  PEER_DISCONNECTED: 'PEER_DISCONNECTED',
  DISCOVER_PEERS: 'DISCOVER_PEERS',
  PEERS_LIST: 'PEERS_LIST',
  CONNECTION_REQUEST: 'CONNECTION_REQUEST',
  CONNECTION_REQUEST_RECEIVED: 'CONNECTION_REQUEST_RECEIVED',
  CONNECTION_RESPONSE: 'CONNECTION_RESPONSE',
  CONNECTION_ACCEPTED: 'CONNECTION_ACCEPTED',
  CONNECTION_REJECTED: 'CONNECTION_REJECTED',
  SESSION_CREATED: 'SESSION_CREATED',
  SEND_MESSAGE: 'SEND_MESSAGE',
  MESSAGE_RECEIVED: 'MESSAGE_RECEIVED',
  ERROR: 'ERROR',
  PING: 'PING',
  PONG: 'PONG',
} as const;

export interface PeerInfo {
  id: string;
  profile?: { displayName?: string; role?: string; ide?: string };
  status?: string;
  connectionMode?: 'LAN' | 'REMOTE';
}

export interface PeersListPayload {
  peers: PeerInfo[];
}

export interface ConnectionRequestReceivedPayload {
  requestId: string;
  from?: { id: string; profile?: { displayName?: string; role?: string; ide?: string } };
}

export interface SessionCreatedPayload {
  sessionId: string;
  peer?: { id: string; profile?: { displayName?: string; role?: string; ide?: string } };
}

export interface MessageReceivedPayload {
  sessionId: string;
  from: string;
  content: unknown;
  type?: string;
  correlationId?: string;
  timestamp?: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface WebSocketPeerProtocolCallbacks {
  onConnectionState?: (state: ConnectionState) => void;
  onAuthSuccess?: (data: { userId: string; displayName?: string; email?: string }) => void;
  onAuthFailed?: (data: { code?: string; message?: string }) => void;
  onPeersList?: (data: PeersListPayload) => void;
  onPeerStatusUpdate?: (data: PeerInfo) => void;
  onConnectionRequestReceived?: (data: ConnectionRequestReceivedPayload) => void;
  onConnectionAccepted?: (data: { requestId: string; sessionId: string; peer?: PeerInfo }) => void;
  onConnectionRejected?: (data: { requestId: string; targetId?: string }) => void;
  onSessionCreated?: (data: SessionCreatedPayload) => void;
  onMessageReceived?: (data: MessageReceivedPayload) => void;
  onError?: (data: { code?: string; message?: string }) => void;
}

export class WebSocketPeerProtocol {
  private socket: WebSocket | null = null;
  private serverUrl = '';
  private token = '';
  private callbacks: WebSocketPeerProtocolCallbacks = {};
  private connectionState: ConnectionState = 'disconnected';
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectBaseMs = 2000;

  /**
   * Set callbacks for backend events (production: real-time only).
   */
  public setCallbacks(cb: WebSocketPeerProtocolCallbacks): void {
    this.callbacks = { ...this.callbacks, ...cb };
  }

  /**
   * Connect to backend WebSocket and authenticate.
   * Must send AUTH immediately after open; no other events before AUTH.
   */
  public connect(serverUrl: string, accessToken: string): Promise<boolean> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      log.info('Already connected');
      return Promise.resolve(true);
    }

    this.serverUrl = serverUrl.replace(/^http/, 'ws').replace(/\/$/, '');
    const wsUrl = `${this.serverUrl}/ws`;
    this.token = accessToken;
    this.setConnectionState('connecting');

    return new Promise((resolve) => {
      try {
        this.socket = new WebSocket(wsUrl);
      } catch (e) {
        log.error('WebSocket constructor failed', e as Error);
        this.setConnectionState('error');
        resolve(false);
        return;
      }

      this.socket.onopen = () => {
        log.info('WebSocket open, sending AUTH');
        this.send(WsEvents.AUTH, { token: this.token });
      };

      this.socket.onmessage = (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string) as { event: string; data?: unknown };
          this.handleMessage(msg.event, msg.data);
        } catch (err) {
          log.warn('Invalid message', { error: err });
        }
      };

      this.socket.onerror = () => {
        log.error('WebSocket error', new Error('WebSocket error'));
        this.setConnectionState('error');
        resolve(false);
      };

      this.socket.onclose = (event) => {
        log.info('WebSocket closed', { code: event.code, reason: event.reason });
        this.socket = null;
        this.stopHeartbeat();
        this.setConnectionState('disconnected');
        // Auth failure codes (4001=invalid token, 4002=token expired) - DO NOT auto-reconnect
        // User must re-authenticate via Supabase OAuth
        if (event.code !== 4001 && event.code !== 4002) {
          this.scheduleReconnect(resolve);
        } else {
          log.warn('Auth failure - not reconnecting', { code: event.code });
          resolve(false);
        }
      };

      // Resolve only after AUTH_SUCCESS or AUTH_FAILED
      const originalOnAuthSuccess = this.callbacks.onAuthSuccess;
      const originalOnAuthFailed = this.callbacks.onAuthFailed;
      this.callbacks.onAuthSuccess = (data) => {
        originalOnAuthSuccess?.(data);
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        resolve(true);
      };
      this.callbacks.onAuthFailed = (data) => {
        originalOnAuthFailed?.(data);
        this.close();
        resolve(false);
      };
    });
  }

  /**
   * Disconnect and clear state.
   */
  public disconnect(): void {
    this.reconnectAttempts = this.maxReconnectAttempts;
    this.close();
  }

  private close(): void {
    this.stopHeartbeat();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setConnectionState('disconnected');
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionState?.(state);
  }

  public getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  private send(event: string, data?: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ event, data: data ?? {} }));
  }

  private handleMessage(event: string, data?: unknown): void {
    const d = data as unknown;
    switch (event) {
      case WsEvents.AUTH_SUCCESS:
        this.callbacks.onAuthSuccess?.(d as { userId: string; displayName?: string; email?: string });
        break;
      case WsEvents.AUTH_FAILED:
        this.callbacks.onAuthFailed?.(d as { code?: string; message?: string });
        break;
      case WsEvents.PEER_REGISTERED:
        break;
      case WsEvents.PEERS_LIST:
        this.callbacks.onPeersList?.(d as PeersListPayload);
        break;
      case WsEvents.PEER_STATUS_UPDATE:
        this.callbacks.onPeerStatusUpdate?.(d as PeerInfo);
        break;
      case WsEvents.CONNECTION_REQUEST_RECEIVED:
        this.callbacks.onConnectionRequestReceived?.(d as ConnectionRequestReceivedPayload);
        break;
      case WsEvents.CONNECTION_ACCEPTED:
        this.callbacks.onConnectionAccepted?.(d as { requestId: string; sessionId: string; peer?: PeerInfo });
        break;
      case WsEvents.CONNECTION_REJECTED:
        this.callbacks.onConnectionRejected?.(d as { requestId: string; targetId?: string });
        break;
      case WsEvents.SESSION_CREATED:
        this.callbacks.onSessionCreated?.(d as SessionCreatedPayload);
        break;
      case WsEvents.MESSAGE_RECEIVED:
        this.callbacks.onMessageReceived?.(d as MessageReceivedPayload);
        break;
      case WsEvents.ERROR:
        this.callbacks.onError?.(d as { code?: string; message?: string });
        break;
      case WsEvents.PONG:
        break;
      default:
        log.debug('Unknown event', { event });
    }
  }

  private scheduleReconnect(resolveRef?: (value: boolean) => void): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      log.warn('Max reconnect attempts reached');
      resolveRef?.(false);
      return;
    }
    this.reconnectAttempts++;
    const delay = this.reconnectBaseMs * Math.pow(2, this.reconnectAttempts - 1);
    log.info('Scheduling reconnect', { attempt: this.reconnectAttempts, delayMs: delay });
    setTimeout(() => {
      if (this.connectionState === 'disconnected' && this.token) {
        this.connect(this.serverUrl || '', this.token).then(resolveRef);
      }
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.send(WsEvents.PING, {});
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Register as peer after AUTH_SUCCESS (backend expects displayName, ide, role).
   */
  public registerPeer(displayName: string, ide: string, role: string): void {
    this.send(WsEvents.PEER_REGISTER, { displayName, ide, role });
  }

  /**
   * Request peer list from backend (real-time; no mock).
   */
  public discoverPeers(filters?: { role?: string; ide?: string; lanOnly?: boolean }): void {
    this.send(WsEvents.DISCOVER_PEERS, filters ?? {});
  }

  /**
   * Send connection request to target peer.
   */
  public sendConnectionRequest(targetId: string): void {
    this.send(WsEvents.CONNECTION_REQUEST, { targetId });
  }

  /**
   * Accept or reject a connection request.
   */
  public respondToConnectionRequest(requestId: string, accepted: boolean): void {
    this.send(WsEvents.CONNECTION_RESPONSE, { requestId, accepted });
  }

  /**
   * Send message in session (production: real backend routing).
   */
  public sendMessage(
    sessionId: string,
    content: unknown,
    type?: string,
    correlationId?: string,
    messageId?: string,
    replyToId?: string
  ): void {
    this.send(WsEvents.SEND_MESSAGE, {
      sessionId,
      content,
      type: type ?? 'text',
      correlationId,
      messageId,
      replyToId,
    });
  }

  public isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }
}
