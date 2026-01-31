/**
 * PeerSync Dev Connect - Peer Service
 * 
 * Manages peer discovery, connections, and real-time communication.
 * Handles the lifecycle of peer connections and maintains connection state.
 * 
 * TODO: [ ] WebRTC / Gateway integration for P2P connections
 * TODO: [ ] Team rooms for group collaboration
 * TODO: [ ] Presence indicators and activity status
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { CONFIG_KEYS, DEFAULTS, type ConnectionState } from '../utils/constants';
import type { Peer, UserProfile, ConnectionRequest, SessionState } from '../models/session';
import { createInitialSessionState } from '../models/session';
import { AuthService } from './authService';
import { getIdeInfo } from '../protocols/peerProtocol';
import {
  WebSocketPeerProtocol,
  type PeerInfo,
  type PeersListPayload,
  type ConnectionRequestReceivedPayload,
  type SessionCreatedPayload,
  type MessageReceivedPayload,
} from '../protocols/WebSocketPeerProtocol';

/**
 * Peer connection event types
 */
export type PeerEventType = 
  | 'peer_connected' 
  | 'peer_disconnected' 
  | 'peer_discovered'
  | 'connection_request'
  | 'connection_state_changed';

/**
 * Peer event listener
 */
export type PeerEventListener = (
  event: PeerEventType, 
  data: Peer | ConnectionRequest | ConnectionState
) => void;

/**
 * Peer discovery options (backend: role, ide, lanOnly)
 */
export interface DiscoveryOptions {
  role?: string;
  ide?: string;
  onlineOnly?: boolean;
  lanOnly?: boolean;
  limit?: number;
}

/**
 * Peer Service
 * 
 * Manages peer discovery and connection lifecycle.
 */
export class PeerService {
  private readonly context: vscode.ExtensionContext;
  private readonly authService: AuthService;
  private readonly log = logger.createChildLogger('PeerService');

  private state: SessionState;
  private readonly listeners: Set<PeerEventListener> = new Set();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private readonly protocol = new WebSocketPeerProtocol();
  private readonly sessionByPeerId = new Map<string, string>();
  private onMessageReceivedCallback: ((payload: MessageReceivedPayload) => void) | null = null;
  private pendingDiscoverResolve: ((peers: Peer[]) => void) | null = null;
  private discoverTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(context: vscode.ExtensionContext, authService: AuthService) {
    this.context = context;
    this.authService = authService;
    this.state = createInitialSessionState();
    this.setupProtocolCallbacks();
  }

  private setupProtocolCallbacks(): void {
    this.protocol.setCallbacks({
      onConnectionState: (state) => {
        const s = state === 'connected' ? 'connected' : state === 'error' ? 'error' : state === 'connecting' ? 'connecting' : 'disconnected';
        this.updateConnectionState(s as ConnectionState);
      },
      onAuthSuccess: () => {
        const profile = this.authService.getProfile();
        if (profile) {
          const extensionVersion = this.context.extension.packageJSON.version || '0.1.0';
          const ideInfo = getIdeInfo(extensionVersion);
          this.protocol.registerPeer(profile.displayName, ideInfo.name, 'guest');
        }
      },
      onAuthFailed: (data) => {
        this.log.warn('Auth failed - do NOT auto-reconnect', data);
        this.updateConnectionState('error');
        // Do NOT auto-reconnect on auth failure - user must re-authenticate
        this.reconnectAttempts = DEFAULTS.MAX_RECONNECT_ATTEMPTS;
        // Notify user about auth failure
        vscode.window.showErrorMessage(
          'WebSocket authentication failed. Please sign in again.',
          'Sign In'
        ).then(action => {
          if (action === 'Sign In') {
            vscode.commands.executeCommand('peerSync.connect');
          }
        });
      },
      onPeersList: (data: PeersListPayload) => {
        const peers = this.mapPeerInfoListToPeers(data.peers);
        peers.forEach((peer) => {
          if (!this.state.peers.has(peer.id)) this.notifyListeners('peer_discovered', peer);
          this.state.peers.set(peer.id, peer);
        });
        if (this.pendingDiscoverResolve) {
          this.pendingDiscoverResolve(peers);
          this.pendingDiscoverResolve = null;
          if (this.discoverTimeout) clearTimeout(this.discoverTimeout);
          this.discoverTimeout = null;
        }
      },
      onPeerStatusUpdate: (data: PeerInfo) => {
        const peer = this.state.peers.get(data.id);
        if (peer) {
          peer.profile.status = (data.status as UserProfile['status']) || 'online';
          this.state.peers.set(data.id, peer);
          this.notifyListeners('peer_disconnected', peer);
        }
      },
      onConnectionRequestReceived: (data: ConnectionRequestReceivedPayload) => {
        const from = data.from;
        if (!from) return;
        const profile: UserProfile = {
          id: from.id,
          displayName: from.profile?.displayName ?? 'Unknown',
          email: '',
          role: 'other',
          status: 'online',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        };
        const request: ConnectionRequest = {
          id: data.requestId,
          fromPeer: profile,
          requestedAt: new Date().toISOString(),
          status: 'pending',
        };
        this.state.pendingRequests.push(request);
        this.notifyListeners('connection_request', request);
      },
      onConnectionAccepted: (data) => {
        if (data.peer?.id && data.sessionId) {
          this.sessionByPeerId.set(data.peer.id, data.sessionId);
          const peer = this.ensurePeerFromInfo(data.peer);
          peer.connectionState = 'connected';
          peer.connectedAt = new Date().toISOString();
          this.state.peers.set(peer.id, peer);
          this.notifyListeners('peer_connected', peer);
        }
      },
      onConnectionRejected: () => {
        this.log.info('Connection rejected');
      },
      onSessionCreated: (data: SessionCreatedPayload) => {
        if (data.peer?.id && data.sessionId) {
          this.sessionByPeerId.set(data.peer.id, data.sessionId);
          const peer = this.ensurePeerFromInfo(data.peer);
          peer.connectionState = 'connected';
          peer.connectedAt = new Date().toISOString();
          this.state.peers.set(peer.id, peer);
          this.notifyListeners('peer_connected', peer);
        }
      },
      onMessageReceived: (payload) => {
        this.onMessageReceivedCallback?.(payload);
      },
      onError: (data) => {
        this.log.warn('Protocol error', data);
      },
    });
  }

  private mapPeerInfoToPeer(info: PeerInfo): Peer {
    const profile: UserProfile = {
      id: info.id,
      displayName: info.profile?.displayName ?? info.id,
      email: '',
      role: (info.profile?.role as UserProfile['role']) ?? 'other',
      status: (info.status as UserProfile['status']) ?? 'online',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    return {
      id: info.id,
      profile,
      connectionState: 'disconnected',
      unreadCount: 0,
    };
  }

  private mapPeerInfoListToPeers(infos: PeerInfo[]): Peer[] {
    return infos.map((info) => this.mapPeerInfoToPeer(info));
  }

  private ensurePeerFromInfo(info: PeerInfo): Peer {
    let peer = this.state.peers.get(info.id);
    if (!peer) peer = this.mapPeerInfoToPeer(info);
    return peer;
  }

  /**
   * Initialize the peer service (real-time backend; no mock).
   */
  public async initialize(): Promise<void> {
    this.log.info('Initializing peer service');

    this.authService.onAuthEvent((event, session) => {
      if (event === 'login' && session?.profile) {
        const autoConnect = vscode.workspace.getConfiguration()
          .get<boolean>(CONFIG_KEYS.AUTO_CONNECT, DEFAULTS.AUTO_CONNECT);
        if (autoConnect) {
          this.connect().catch((err) => this.log.error('Auto-connect failed', err));
        }
      } else if (event === 'logout' || event === 'expired') {
        this.disconnect();
        this.sessionByPeerId.clear();
      }
    });

    await this.loadCachedPeers();
  }

  /**
   * Register callback for incoming messages (used by MessageRouter).
   */
  public setOnMessageReceived(cb: (payload: MessageReceivedPayload) => void): void {
    this.onMessageReceivedCallback = cb;
  }

  /**
   * Get session ID for a peer (required to send messages).
   */
  public getSessionIdForPeer(peerId: string): string | undefined {
    return this.sessionByPeerId.get(peerId);
  }

  /**
   * Send message via backend (production real-time).
   */
  public sendMessage(
    sessionId: string,
    content: unknown,
    type?: string,
    correlationId?: string,
    messageId?: string,
    replyToId?: string
  ): void {
    this.protocol.sendMessage(sessionId, content, type, correlationId, messageId, replyToId);
  }

  /**
   * Connect to the peer network (real-time WebSocket backend).
   */
  public async connect(): Promise<boolean> {
    if (!this.authService.isAuthenticated()) {
      this.log.warn('Cannot connect - not authenticated');
      return false;
    }

    const token = this.authService.getAccessToken();
    if (!token) {
      this.log.warn('No access token');
      return false;
    }

    if (this.protocol.getConnectionState() === 'connected') {
      this.log.info('Already connected');
      this.updateConnectionState('connected');
      return true;
    }

    this.log.info('Connecting to peer network');
    this.updateConnectionState('connecting');

    const config = vscode.workspace.getConfiguration();
    const serverUrl = config.get<string>(CONFIG_KEYS.SERVER_URL, DEFAULTS.SERVER_URL);

    try {
      const ok = await this.protocol.connect(serverUrl, token);
      if (ok) {
        this.updateConnectionState('connected');
        this.reconnectAttempts = 0;
        this.log.info('Connected to peer network');
        return true;
      }
      this.updateConnectionState('error');
      this.scheduleReconnect();
      return false;
    } catch (error) {
      this.log.error('Connection failed', error as Error);
      this.updateConnectionState('error');
      this.scheduleReconnect();
      return false;
    }
  }

  /**
   * Disconnect from the peer network
   */
  public disconnect(): void {
    this.log.info('Disconnecting from peer network');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.protocol.disconnect();
    this.sessionByPeerId.clear();

    this.state.peers.forEach((peer) => {
      peer.connectionState = 'disconnected';
      this.notifyListeners('peer_disconnected', peer);
    });

    this.updateConnectionState('disconnected');
    this.reconnectAttempts = 0;
  }

  /**
   * Discover available peers (real-time from backend; no mock).
   */
  public async discoverPeers(options: DiscoveryOptions = {}): Promise<Peer[]> {
    if (!this.authService.isAuthenticated()) {
      this.log.warn('Cannot discover peers - not authenticated');
      return [];
    }

    if (this.protocol.getConnectionState() !== 'connected') {
      this.log.warn('Not connected - connect first');
      return [];
    }

    this.log.info('Discovering peers', { options });

    return new Promise<Peer[]>((resolve) => {
      const timeoutMs = 10000;
      this.pendingDiscoverResolve = resolve;
      this.protocol.discoverPeers({
        role: options.role,
        ide: options.ide,
        lanOnly: options.lanOnly,
      });
      this.discoverTimeout = setTimeout(() => {
        if (this.pendingDiscoverResolve) {
          this.pendingDiscoverResolve(Array.from(this.state.peers.values()));
          this.pendingDiscoverResolve = null;
        }
        this.discoverTimeout = null;
      }, timeoutMs);
    });
  }

  /**
   * Connect to a specific peer (sends connection request; session created on accept).
   */
  public async connectToPeer(peerId: string): Promise<boolean> {
    const peer = this.state.peers.get(peerId);
    if (!peer) {
      this.log.warn('Peer not found', { peerId });
      return false;
    }

    if (peer.connectionState === 'connected') {
      this.log.info('Already connected to peer', { peerId });
      return true;
    }

    this.log.info('Sending connection request to peer', { peerId });
    this.protocol.sendConnectionRequest(peerId);
    return true;
  }

  /**
   * Disconnect from a specific peer (local state only; backend session remains until disconnect).
   */
  public async disconnectFromPeer(peerId: string): Promise<void> {
    const peer = this.state.peers.get(peerId);
    if (!peer) return;

    this.log.info('Disconnecting from peer', { peerId });
    this.sessionByPeerId.delete(peerId);
    peer.connectionState = 'disconnected';
    this.state.peers.set(peerId, peer);
    this.notifyListeners('peer_disconnected', peer);
  }

  /**
   * Get all connected peers
   */
  public getConnectedPeers(): Peer[] {
    return Array.from(this.state.peers.values())
      .filter(peer => peer.connectionState === 'connected');
  }

  /**
   * Get all known peers
   */
  public getAllPeers(): Peer[] {
    return Array.from(this.state.peers.values());
  }

  /**
   * Get a specific peer by ID
   */
  public getPeer(peerId: string): Peer | undefined {
    return this.state.peers.get(peerId);
  }

  /**
   * Get current connection state
   */
  public getConnectionState(): ConnectionState {
    return this.state.connectionState;
  }

  /**
   * Subscribe to peer events
   */
  public onPeerEvent(listener: PeerEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Send a connection request to a peer (real-time via backend).
   */
  public async sendConnectionRequest(peerId: string, _message?: string): Promise<boolean> {
    if (!this.authService.isAuthenticated()) return false;
    this.log.info('Sending connection request', { peerId });
    this.protocol.sendConnectionRequest(peerId);
    return true;
  }

  /**
   * Accept a connection request (real-time via backend).
   */
  public async acceptConnectionRequest(requestId: string): Promise<boolean> {
    const request = this.state.pendingRequests.find((r) => r.id === requestId);
    if (!request) return false;

    this.log.info('Accepting connection request', { requestId });
    this.protocol.respondToConnectionRequest(requestId, true);
    request.status = 'accepted';
    this.state.pendingRequests = this.state.pendingRequests.filter((r) => r.id !== requestId);
    return true;
  }

  /**
   * Reject a connection request (real-time via backend).
   */
  public async rejectConnectionRequest(requestId: string): Promise<boolean> {
    const request = this.state.pendingRequests.find((r) => r.id === requestId);
    if (!request) return false;

    this.log.info('Rejecting connection request', { requestId });
    this.protocol.respondToConnectionRequest(requestId, false);
    request.status = 'rejected';
    this.state.pendingRequests = this.state.pendingRequests.filter((r) => r.id !== requestId);
    return true;
  }

  /**
   * Update connection state and notify listeners
   */
  private updateConnectionState(state: ConnectionState): void {
    this.state.connectionState = state;
    this.notifyListeners('connection_state_changed', state);
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= DEFAULTS.MAX_RECONNECT_ATTEMPTS) {
      this.log.warn('Max reconnect attempts reached');
      this.updateConnectionState('error');
      return;
    }

    this.reconnectAttempts++;
    this.updateConnectionState('reconnecting');

    const delay = DEFAULTS.RECONNECT_INTERVAL_MS * this.reconnectAttempts;
    this.log.info('Scheduling reconnect', { 
      attempt: this.reconnectAttempts, 
      delayMs: delay 
    });

    this.reconnectTimer = setTimeout(async () => {
      await this.connect();
    }, delay);
  }

  /**
   * Notify listeners of peer events
   */
  private notifyListeners(
    event: PeerEventType, 
    data: Peer | ConnectionRequest | ConnectionState
  ): void {
    this.listeners.forEach(listener => {
      try {
        listener(event, data);
      } catch (error) {
        this.log.error('Peer event listener error', error as Error);
      }
    });
  }

  /**
   * Load cached peers from storage (real peers only).
   */
  private async loadCachedPeers(): Promise<void> {
    try {
      const cached = this.context.globalState.get<string>('peerSync.cachedPeers');
      if (cached) {
        const peers = JSON.parse(cached) as Peer[];
        peers.forEach(peer => {
          peer.connectionState = 'disconnected';
          this.state.peers.set(peer.id, peer);
        });
      }
    } catch (error) {
      this.log.warn('Failed to load cached peers', { error });
    }
  }

  /**
   * Cache peers to storage
   */
  private async cachePeers(): Promise<void> {
    try {
      const peers = Array.from(this.state.peers.values());
      await this.context.globalState.update(
        'peerSync.cachedPeers',
        JSON.stringify(peers)
      );
    } catch (error) {
      this.log.warn('Failed to cache peers', { error });
    }
  }

  /**
   * Dispose of service resources
   */
  public dispose(): void {
    this.disconnect();
    this.listeners.clear();
  }
}
