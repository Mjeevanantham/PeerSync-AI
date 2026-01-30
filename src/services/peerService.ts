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
import { 
  CONNECTION_STATE, 
  CONFIG_KEYS, 
  DEFAULTS,
  API_ENDPOINTS,
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
  ProtocolMessageFactory, 
  ProtocolMessageParser,
  DEFAULT_CAPABILITIES,
  getIdeInfo,
  type ProtocolMessage,
  ProtocolMessageType
} from '../protocols/peerProtocol';

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
 * Peer discovery options
 */
export interface DiscoveryOptions {
  /** Filter by user role */
  role?: string;
  /** Filter by online status */
  onlineOnly?: boolean;
  /** Maximum results */
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
  
  private messageFactory: ProtocolMessageFactory | null = null;
  private readonly messageParser: ProtocolMessageParser;

  constructor(context: vscode.ExtensionContext, authService: AuthService) {
    this.context = context;
    this.authService = authService;
    this.state = createInitialSessionState();
    this.messageParser = new ProtocolMessageParser();
  }

  /**
   * Initialize the peer service
   */
  public async initialize(): Promise<void> {
    this.log.info('Initializing peer service');
    
    // Initialize protocol message factory if authenticated
    const profile = this.authService.getProfile();
    if (profile) {
      const extensionVersion = this.context.extension.packageJSON.version || '0.1.0';
      const ideInfo = getIdeInfo(extensionVersion);
      this.messageFactory = new ProtocolMessageFactory(profile.id, ideInfo);
    }

    // Subscribe to auth events
    this.authService.onAuthEvent((event, session) => {
      if (event === 'login' && session?.profile) {
        const extensionVersion = this.context.extension.packageJSON.version || '0.1.0';
        const ideInfo = getIdeInfo(extensionVersion);
        this.messageFactory = new ProtocolMessageFactory(session.profile.id, ideInfo);
        
        // Auto-connect if configured
        const autoConnect = vscode.workspace.getConfiguration()
          .get<boolean>(CONFIG_KEYS.AUTO_CONNECT, DEFAULTS.AUTO_CONNECT);
        if (autoConnect) {
          this.connect().catch(err => this.log.error('Auto-connect failed', err));
        }
      } else if (event === 'logout' || event === 'expired') {
        this.disconnect();
        this.messageFactory = null;
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
      // TODO: [ ] WebRTC / Gateway connection implementation
      // This is where the actual WebSocket/WebRTC connection would be established
      
      await this.performConnect();
      
      this.updateConnectionState('connected');
      this.reconnectAttempts = 0;
      
      this.log.info('Connected to peer network');
      return true;
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

    // Send disconnect to all connected peers
    if (this.messageFactory) {
      const disconnectMsg = this.messageFactory.createDisconnect(null);
      this.broadcastMessage(disconnectMsg);
    }

    // Clear peer connections
    this.state.peers.forEach((peer, id) => {
      peer.connectionState = 'disconnected';
      this.notifyListeners('peer_disconnected', peer);
    });

    this.updateConnectionState('disconnected');
    this.reconnectAttempts = 0;
  }

  /**
   * Discover available peers
   */
  public async discoverPeers(options: DiscoveryOptions = {}): Promise<Peer[]> {
    if (!this.authService.isAuthenticated()) {
      this.log.warn('Cannot discover peers - not authenticated');
      return [];
    }

    this.log.info('Discovering peers', { options });

    try {
      // TODO: [ ] Implement actual API call
      const peers = await this.performPeerDiscovery(options);
      
      // Update local state
      peers.forEach(peer => {
        if (!this.state.peers.has(peer.id)) {
          this.notifyListeners('peer_discovered', peer);
        }
        this.state.peers.set(peer.id, peer);
      });

      // Cache discovered peers
      await this.cachePeers();
      
      return peers;
    } catch (error) {
      this.log.error('Peer discovery failed', error as Error);
      throw error;
    }
  }

  /**
   * Connect to a specific peer
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

    this.log.info('Connecting to peer', { peerId });

    try {
      // Send handshake
      if (this.messageFactory) {
        const profile = this.authService.getProfile()!;
        const handshake = this.messageFactory.createHandshake(
          peerId,
          profile,
          DEFAULT_CAPABILITIES
        );
        await this.sendProtocolMessage(handshake);
      }

      // TODO: [ ] WebRTC / Gateway - establish direct connection

      peer.connectionState = 'connected';
      peer.connectedAt = new Date().toISOString();
      this.state.peers.set(peerId, peer);
      
      this.notifyListeners('peer_connected', peer);
      
      this.log.info('Connected to peer', { peerId });
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

    // Send disconnect message
    if (this.messageFactory) {
      const disconnect = this.messageFactory.createDisconnect(peerId);
      await this.sendProtocolMessage(disconnect);
    }

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
   * Send a connection request to a peer
   */
  public async sendConnectionRequest(
    peerId: string, 
    message?: string
  ): Promise<boolean> {
    if (!this.authService.isAuthenticated()) {
      return false;
    }

    this.log.info('Sending connection request', { peerId });

    // TODO: [ ] Implement connection request API call
    this.log.warn('Connection request not implemented');
    return true;
  }

  /**
   * Accept a connection request
   */
  public async acceptConnectionRequest(requestId: string): Promise<boolean> {
    const request = this.state.pendingRequests
      .find(r => r.id === requestId);
    
    if (!request) {
      return false;
    }

    this.log.info('Accepting connection request', { requestId });

    // TODO: [ ] Implement accept request API call
    request.status = 'accepted';
    
    // Add peer to connected list
    const peer: Peer = {
      id: request.fromPeer.id,
      profile: request.fromPeer,
      connectionState: 'connected',
      connectedAt: new Date().toISOString(),
      unreadCount: 0,
    };
    
    this.state.peers.set(peer.id, peer);
    this.notifyListeners('peer_connected', peer);
    
    // Remove from pending
    this.state.pendingRequests = this.state.pendingRequests
      .filter(r => r.id !== requestId);

    return true;
  }

  /**
   * Reject a connection request
   */
  public async rejectConnectionRequest(requestId: string): Promise<boolean> {
    const request = this.state.pendingRequests
      .find(r => r.id === requestId);
    
    if (!request) {
      return false;
    }

    this.log.info('Rejecting connection request', { requestId });

    // TODO: [ ] Implement reject request API call
    request.status = 'rejected';
    
    // Remove from pending
    this.state.pendingRequests = this.state.pendingRequests
      .filter(r => r.id !== requestId);

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
   * Send a protocol message to a peer
   */
  private async sendProtocolMessage(message: ProtocolMessage): Promise<void> {
    const serialized = this.messageParser.serialize(message);
    
    // TODO: [ ] WebRTC / Gateway - send via actual connection
    this.log.debug('Sending protocol message', { 
      type: message.type, 
      recipientId: message.recipientId 
    });
  }

  /**
   * Broadcast a message to all connected peers
   */
  private broadcastMessage(message: ProtocolMessage): void {
    this.getConnectedPeers().forEach(peer => {
      const peerMessage = { ...message, recipientId: peer.id };
      this.sendProtocolMessage(peerMessage);
    });
  }

  /**
   * Handle incoming protocol message
   */
  public handleIncomingMessage(raw: string): void {
    const message = this.messageParser.parse(raw);
    if (!message) {
      this.log.warn('Failed to parse incoming message');
      return;
    }

    this.log.debug('Received protocol message', { type: message.type });

    switch (message.type) {
      case ProtocolMessageType.HANDSHAKE:
        this.handleHandshake(message);
        break;
      case ProtocolMessageType.PING:
        this.handlePing(message);
        break;
      case ProtocolMessageType.DISCONNECT:
        this.handlePeerDisconnect(message);
        break;
      // TODO: Handle other message types
    }
  }

  /**
   * Handle handshake message
   */
  private handleHandshake(message: ProtocolMessage): void {
    // TODO: Implement handshake response
    this.log.info('Received handshake', { from: message.senderId });
  }

  /**
   * Handle ping message
   */
  private handlePing(message: ProtocolMessage): void {
    if (this.messageFactory) {
      const pong = this.messageFactory.createPong(message.senderId);
      this.sendProtocolMessage(pong);
    }
  }

  /**
   * Handle peer disconnect message
   */
  private handlePeerDisconnect(message: ProtocolMessage): void {
    const peer = this.state.peers.get(message.senderId);
    if (peer) {
      peer.connectionState = 'disconnected';
      this.state.peers.set(message.senderId, peer);
      this.notifyListeners('peer_disconnected', peer);
    }
  }

  /**
   * Perform connection to peer network
   * TODO: [ ] WebRTC / Gateway implementation
   */
  private async performConnect(): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const serverUrl = config.get<string>(CONFIG_KEYS.SERVER_URL, DEFAULTS.SERVER_URL);
    
    // TODO: Implement WebSocket/WebRTC connection
    this.log.warn('Using mock connection - implement actual Gateway/WebRTC');
    
    // Simulate connection delay
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  /**
   * Perform peer discovery
   * TODO: [ ] Implement actual API call
   */
  private async performPeerDiscovery(options: DiscoveryOptions): Promise<Peer[]> {
    const config = vscode.workspace.getConfiguration();
    const serverUrl = config.get<string>(CONFIG_KEYS.SERVER_URL, DEFAULTS.SERVER_URL);
    
    // TODO: Implement actual API call
    this.log.warn('Using mock peer discovery - implement actual API call');
    
    // Return mock peers for MVP
    return [
      {
        id: 'peer_1',
        profile: {
          id: 'peer_1',
          displayName: 'Alice Developer',
          email: 'alice@example.com',
          role: 'frontend',
          status: 'online',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
        connectionState: 'disconnected',
        unreadCount: 0,
      },
      {
        id: 'peer_2',
        profile: {
          id: 'peer_2',
          displayName: 'Bob Engineer',
          email: 'bob@example.com',
          role: 'backend',
          status: 'online',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
        },
        connectionState: 'disconnected',
        unreadCount: 0,
      },
    ];
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
