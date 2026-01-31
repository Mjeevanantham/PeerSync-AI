/**
 * PeerSync Dev Connect - Peer Service
 * 
 * Manages peer discovery, connections, and real-time communication.
 * Integrated with WebSocket backend for real peer network.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { 
  CONNECTION_STATE, 
  CONFIG_KEYS, 
  DEFAULTS,
  type ConnectionState 
} from '../utils/constants';
import type { 
  Peer, 
  UserProfile, 
  ConnectionRequest,
  SessionState 
} from '../models/session';
import { createInitialSessionState } from '../models/session';
import { AuthService } from './authService';
import {
  getWebSocketProtocol,
  type WebSocketPeerProtocol,
  type ProtocolEventType,
  type PeerInfo,
  type PeersListPayload,
  type ConnectionRequestReceivedPayload,
  type ConnectionAcceptedPayload,
  type SessionCreatedPayload,
  type ErrorPayload,
} from '../protocols/WebSocketPeerProtocol';

/**
 * Peer connection event types
 */
export type PeerEventType = 
  | 'peer_connected' 
  | 'peer_disconnected' 
  | 'peer_discovered'
  | 'peers_updated'
  | 'connection_request'
  | 'connection_accepted'
  | 'connection_rejected'
  | 'session_created'
  | 'connection_state_changed'
  | 'error';

/**
 * Peer event listener
 */
export type PeerEventListener = (
  event: PeerEventType, 
  data: Peer | Peer[] | ConnectionRequest | ConnectionState | string | null
) => void;

/**
 * Peer discovery options
 */
export interface DiscoveryOptions {
  role?: string;
  ide?: string;
  onlineOnly?: boolean;
  limit?: number;
  // ═══════════════════════════════════════════════════════════════════════════
  // LAN MODE ADDITION – SAFE EXTENSION
  // ═══════════════════════════════════════════════════════════════════════════
  /** If true, only return peers on the same network (LAN) */
  lanOnly?: boolean;
  // ═══════════════════════════════════════════════════════════════════════════
}

/**
 * Peer Service - Real WebSocket implementation
 */
export class PeerService {
  private readonly context: vscode.ExtensionContext;
  private readonly authService: AuthService;
  private readonly log = logger.createChildLogger('PeerService');
  
  private protocol: WebSocketPeerProtocol;
  private state: SessionState;
  private readonly listeners: Set<PeerEventListener> = new Set();
  private protocolSubscription: vscode.Disposable | null = null;

  constructor(context: vscode.ExtensionContext, authService: AuthService) {
    this.context = context;
    this.authService = authService;
    this.state = createInitialSessionState();
    this.protocol = getWebSocketProtocol();
  }

  /**
   * Initialize the peer service
   */
  public async initialize(): Promise<void> {
    this.log.info('Initializing peer service');
    
    // Subscribe to protocol events
    this.protocolSubscription = this.protocol.onEvent(
      (event, data) => this.handleProtocolEvent(event, data)
    );

    // Subscribe to auth events
    this.authService.onAuthEvent((event, session) => {
      if (event === 'login' && session?.profile) {
        const autoConnect = vscode.workspace.getConfiguration()
          .get<boolean>(CONFIG_KEYS.AUTO_CONNECT, DEFAULTS.AUTO_CONNECT);
        if (autoConnect) {
          this.connect().catch(err => this.log.error('Auto-connect failed', err));
        }
      } else if (event === 'logout' || event === 'expired') {
        this.disconnect();
      }
    });

    // Load cached peers
    await this.loadCachedPeers();
  }

  /**
   * Connect to the peer network
   */
  public async connect(): Promise<boolean> {
    if (!this.authService.isAuthenticated()) {
      this.log.warn('Cannot connect - not authenticated');
      return false;
    }

    if (this.state.connectionState === 'connected') {
      this.log.info('Already connected');
      return true;
    }

    this.log.info('Connecting to peer network');
    this.updateConnectionState('connecting');

    try {
      // Step 1: Connect WebSocket
      const connected = await this.protocol.connect();
      if (!connected) {
        this.log.warn('WebSocket connection failed');
        this.updateConnectionState('error');
        return false;
      }

      // Step 2: Authenticate with backend
      const token = this.authService.getAccessToken();
      if (!token) {
        this.log.warn('No access token available');
        this.updateConnectionState('error');
        return false;
      }

      const authenticated = await this.protocol.authenticate(token);
      if (!authenticated) {
        this.log.warn('Authentication failed');
        this.updateConnectionState('error');
        return false;
      }

      // Step 3: Register as peer
      const profile = this.authService.getProfile();
      if (profile) {
        const extensionVersion = this.context.extension.packageJSON.version || '0.1.0';
        this.protocol.registerPeer(
          profile.displayName,
          'vscode', // or detect actual IDE
          profile.role
        );
      }

      this.updateConnectionState('connected');
      this.log.info('Connected to peer network');
      return true;
    } catch (error) {
      this.log.error('Connection failed', error as Error);
      this.updateConnectionState('error');
      return false;
    }
  }

  /**
   * Disconnect from the peer network
   */
  public disconnect(): void {
    this.log.info('Disconnecting from peer network');
    
    this.protocol.disconnect();
    
    // Update all peers to disconnected
    this.state.peers.forEach((peer, id) => {
      peer.connectionState = 'disconnected';
      this.notifyListeners('peer_disconnected', peer);
    });

    this.updateConnectionState('disconnected');
  }

  /**
   * Discover available peers
   * 
   * @param options - Discovery options including optional lanOnly filter
   */
  public async discoverPeers(options: DiscoveryOptions = {}): Promise<Peer[]> {
    if (!this.authService.isAuthenticated()) {
      this.log.warn('Cannot discover peers - not authenticated');
      return [];
    }

    if (!this.protocol.isAuthenticatedState()) {
      this.log.warn('Cannot discover peers - protocol not authenticated');
      return [];
    }

    this.log.info('Discovering peers', { options });
    
    // ═══════════════════════════════════════════════════════════════════════════
    // LAN MODE ADDITION – Pass lanOnly filter to backend
    // ═══════════════════════════════════════════════════════════════════════════
    this.protocol.discoverPeers({
      role: options.role,
      ide: options.ide,
      lanOnly: options.lanOnly, // LAN MODE ADDITION
    });
    // ═══════════════════════════════════════════════════════════════════════════

    // Return current known peers (will be updated via event)
    return this.getAllPeers();
  }

  /**
   * Connect to a specific peer (send connection request)
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

    try {
      // Send connection request - will get SESSION_CREATED on accept
      const sessionId = await this.protocol.sendConnectionRequest(peerId);
      
      peer.connectionState = 'connected';
      peer.connectedAt = new Date().toISOString();
      this.state.peers.set(peerId, peer);
      
      this.notifyListeners('peer_connected', peer);
      this.log.info('Connected to peer', { peerId, sessionId });
      return true;
    } catch (error) {
      this.log.error('Failed to connect to peer', error as Error, { peerId });
      peer.connectionState = 'error';
      this.state.peers.set(peerId, peer);
      return false;
    }
  }

  /**
   * Disconnect from a specific peer
   */
  public async disconnectFromPeer(peerId: string): Promise<void> {
    const peer = this.state.peers.get(peerId);
    if (!peer) {
      return;
    }

    this.log.info('Disconnecting from peer', { peerId });
    peer.connectionState = 'disconnected';
    this.state.peers.set(peerId, peer);
    this.notifyListeners('peer_disconnected', peer);
  }

  /**
   * Accept a connection request
   */
  public async acceptConnectionRequest(requestId: string): Promise<boolean> {
    const request = this.state.pendingRequests.find(r => r.id === requestId);
    
    if (!request) {
      this.log.warn('Connection request not found', { requestId });
      return false;
    }

    this.log.info('Accepting connection request', { requestId });
    this.protocol.respondToConnectionRequest(requestId, true);

    // Remove from pending
    this.state.pendingRequests = this.state.pendingRequests.filter(r => r.id !== requestId);
    
    return true;
  }

  /**
   * Reject a connection request
   */
  public async rejectConnectionRequest(requestId: string): Promise<boolean> {
    const request = this.state.pendingRequests.find(r => r.id === requestId);
    
    if (!request) {
      return false;
    }

    this.log.info('Rejecting connection request', { requestId });
    this.protocol.respondToConnectionRequest(requestId, false);

    // Remove from pending
    this.state.pendingRequests = this.state.pendingRequests.filter(r => r.id !== requestId);
    
    return true;
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

  // ═══════════════════════════════════════════════════════════════════════════════
  // LAN MODE ADDITION – SAFE EXTENSION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get only LAN peers (peers on the same network)
   */
  public getLanPeers(): Peer[] {
    return Array.from(this.state.peers.values())
      .filter(peer => peer.connectionMode === 'LAN');
  }

  /**
   * Get remote peers (peers on different networks)
   */
  public getRemotePeers(): Peer[] {
    return Array.from(this.state.peers.values())
      .filter(peer => peer.connectionMode !== 'LAN');
  }

  /**
   * Check if a peer is on the same LAN
   */
  public isPeerOnLan(peerId: string): boolean {
    const peer = this.state.peers.get(peerId);
    return peer?.connectionMode === 'LAN';
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // END LAN MODE ADDITION
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Get a specific peer by ID
   */
  public getPeer(peerId: string): Peer | undefined {
    return this.state.peers.get(peerId);
  }

  /**
   * Get pending connection requests
   */
  public getPendingRequests(): ConnectionRequest[] {
    return [...this.state.pendingRequests];
  }

  /**
   * Get current connection state
   */
  public getConnectionState(): ConnectionState {
    return this.state.connectionState;
  }

  /**
   * Get current session ID
   */
  public getCurrentSessionId(): string | null {
    return this.protocol.getCurrentSessionId();
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
   * Handle protocol events from WebSocket
   */
  private handleProtocolEvent(event: ProtocolEventType, data: unknown): void {
    switch (event) {
      case 'connected':
        // WebSocket connected, but not fully ready until authenticated
        break;

      case 'disconnected':
        this.updateConnectionState('disconnected');
        // Mark all peers as disconnected
        this.state.peers.forEach((peer) => {
          peer.connectionState = 'disconnected';
        });
        break;

      case 'authenticated':
        this.log.info('Protocol authenticated');
        break;

      case 'auth_failed':
        this.log.warn('Protocol auth failed');
        this.updateConnectionState('error');
        this.notifyListeners('error', 'Authentication failed');
        break;

      case 'peer_registered':
        this.log.info('Peer registered with backend');
        break;

      case 'peers_list':
        this.handlePeersList(data as PeersListPayload);
        break;

      case 'peer_status_update':
        this.handlePeerStatusUpdate(data as PeerInfo);
        break;

      case 'connection_request_received':
        this.handleConnectionRequestReceived(data as ConnectionRequestReceivedPayload);
        break;

      case 'connection_accepted':
        this.handleConnectionAccepted(data as ConnectionAcceptedPayload);
        break;

      case 'connection_rejected':
        this.log.info('Connection was rejected');
        this.notifyListeners('connection_rejected', null);
        break;

      case 'session_created':
        this.handleSessionCreated(data as SessionCreatedPayload);
        break;

      case 'session_ended':
        this.log.info('Session ended');
        break;

      case 'error':
        const errorData = data as ErrorPayload;
        this.log.warn('Protocol error', { code: errorData.code, message: errorData.message });
        this.notifyListeners('error', errorData.message);
        break;
    }
  }

  /**
   * Handle peers list from backend
   */
  private handlePeersList(data: PeersListPayload): void {
    this.log.info('Received peers list', { count: data.peers.length });

    const myUserId = this.protocol.getUserId();

    data.peers.forEach(peerInfo => {
      // Skip self
      if (peerInfo.id === myUserId) {
        return;
      }

      const existingPeer = this.state.peers.get(peerInfo.id);
      
      // ═══════════════════════════════════════════════════════════════════════════
      // LAN MODE ADDITION – Include connectionMode from backend
      // ═══════════════════════════════════════════════════════════════════════════
      const peer: Peer = {
        id: peerInfo.id,
        profile: {
          id: peerInfo.id,
          displayName: peerInfo.profile?.displayName || 'Unknown',
          email: '', // Not provided by backend
          role: (peerInfo.profile?.role as Peer['profile']['role']) || 'other',
          status: (peerInfo.status as Peer['profile']['status']) || 'online',
          createdAt: existingPeer?.profile.createdAt || new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
        connectionState: existingPeer?.connectionState || 'disconnected',
        unreadCount: existingPeer?.unreadCount || 0,
        // LAN MODE ADDITION – Store connection mode
        connectionMode: peerInfo.connectionMode || 'REMOTE',
      };
      // ═══════════════════════════════════════════════════════════════════════════

      this.state.peers.set(peerInfo.id, peer);

      if (!existingPeer) {
        this.notifyListeners('peer_discovered', peer);
      }
    });

    // Cache and notify
    this.cachePeers();
    this.notifyListeners('peers_updated', this.getAllPeers());
  }

  /**
   * Handle peer status update
   */
  private handlePeerStatusUpdate(data: PeerInfo): void {
    this.log.debug('Peer status update', { peerId: data.id, status: data.status });

    let peer = this.state.peers.get(data.id);
    
    if (data.status === 'offline') {
      // Peer went offline
      if (peer) {
        peer.profile.status = 'offline';
        peer.connectionState = 'disconnected';
        this.state.peers.set(data.id, peer);
        this.notifyListeners('peer_disconnected', peer);
      }
    } else {
      // Peer came online or updated
      if (!peer && data.profile) {
        // ═══════════════════════════════════════════════════════════════════════
        // LAN MODE ADDITION – Include connectionMode for new peers
        // ═══════════════════════════════════════════════════════════════════════
        peer = {
          id: data.id,
          profile: {
            id: data.id,
            displayName: data.profile.displayName,
            email: '',
            role: data.profile.role as Peer['profile']['role'] || 'other',
            status: data.status as Peer['profile']['status'] || 'online',
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
          },
          connectionState: 'disconnected',
          unreadCount: 0,
          connectionMode: data.connectionMode || 'REMOTE', // LAN MODE ADDITION
        };
        // ═══════════════════════════════════════════════════════════════════════
        this.state.peers.set(data.id, peer);
        this.notifyListeners('peer_discovered', peer);
      } else if (peer) {
        peer.profile.status = data.status as Peer['profile']['status'] || 'online';
        peer.profile.lastActiveAt = new Date().toISOString();
        // LAN MODE ADDITION – Update connectionMode if provided
        if (data.connectionMode) {
          peer.connectionMode = data.connectionMode;
        }
        this.state.peers.set(data.id, peer);
      }
    }

    this.notifyListeners('peers_updated', this.getAllPeers());
  }

  /**
   * Handle incoming connection request
   */
  private handleConnectionRequestReceived(data: ConnectionRequestReceivedPayload): void {
    this.log.info('Connection request received', { requestId: data.requestId, from: data.from.id });

    const request: ConnectionRequest = {
      id: data.requestId,
      fromPeer: {
        id: data.from.id,
        displayName: data.from.profile?.displayName || 'Unknown',
        email: '',
        role: (data.from.profile?.role as UserProfile['role']) || 'other',
        status: 'online',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      },
      requestedAt: new Date().toISOString(),
      status: 'pending',
    };

    this.state.pendingRequests.push(request);
    this.notifyListeners('connection_request', request);

    // Show notification
    vscode.window.showInformationMessage(
      `${request.fromPeer.displayName} wants to connect with you`,
      'Accept',
      'Reject'
    ).then(selection => {
      if (selection === 'Accept') {
        this.acceptConnectionRequest(data.requestId);
      } else if (selection === 'Reject') {
        this.rejectConnectionRequest(data.requestId);
      }
    });
  }

  /**
   * Handle connection accepted
   */
  private handleConnectionAccepted(data: ConnectionAcceptedPayload): void {
    this.log.info('Connection accepted', { sessionId: data.sessionId });

    const peer = this.state.peers.get(data.peer.id);
    if (peer) {
      peer.connectionState = 'connected';
      peer.connectedAt = new Date().toISOString();
      this.state.peers.set(data.peer.id, peer);
      this.notifyListeners('connection_accepted', peer);
    }
  }

  /**
   * Handle session created (when we accept a request)
   */
  private handleSessionCreated(data: SessionCreatedPayload): void {
    this.log.info('Session created', { sessionId: data.sessionId });

    // Add the peer if not already known
    let peer = this.state.peers.get(data.peer.id);
    if (!peer && data.peer.profile) {
      peer = {
        id: data.peer.id,
        profile: {
          id: data.peer.id,
          displayName: data.peer.profile.displayName,
          email: '',
          role: data.peer.profile.role as Peer['profile']['role'] || 'other',
          status: 'online',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
        connectionState: 'connected',
        connectedAt: new Date().toISOString(),
        unreadCount: 0,
      };
      this.state.peers.set(data.peer.id, peer);
    } else if (peer) {
      peer.connectionState = 'connected';
      peer.connectedAt = new Date().toISOString();
      this.state.peers.set(data.peer.id, peer);
    }

    this.notifyListeners('session_created', data.sessionId);
    this.notifyListeners('peer_connected', peer!);

    // Open chat view automatically
    vscode.commands.executeCommand('peerSync.openChat', data.peer.id);
  }

  /**
   * Update connection state and notify listeners
   */
  private updateConnectionState(state: ConnectionState): void {
    this.state.connectionState = state;
    this.notifyListeners('connection_state_changed', state);
  }

  /**
   * Notify listeners of peer events
   */
  private notifyListeners(
    event: PeerEventType, 
    data: Peer | Peer[] | ConnectionRequest | ConnectionState | string | null
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
   * Load cached peers from storage
   */
  private async loadCachedPeers(): Promise<void> {
    try {
      const cached = this.context.globalState.get<string>('peerSync.cachedPeers');
      if (cached) {
        const peers = JSON.parse(cached) as Peer[];
        peers.forEach(peer => {
          peer.connectionState = 'disconnected';
          peer.profile.status = 'offline';
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
    if (this.protocolSubscription) {
      this.protocolSubscription.dispose();
    }
  }
}
