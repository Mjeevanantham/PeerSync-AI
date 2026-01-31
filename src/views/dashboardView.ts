/**
 * PeerSync Dev Connect - Dashboard WebView
 * 
 * Main dashboard showing user profile, active peers, connection status,
 * and recent chat activity. Provides quick access to all extension features.
 * 
 * TODO: [ ] Analytics dashboard integration
 * TODO: [ ] Team rooms overview
 * TODO: [ ] Activity feed
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { WEBVIEW_MESSAGES, COMMANDS, VIEWS } from '../utils/constants';
import { AuthService } from '../services/authService';
import { PeerService } from '../services/peerService';
import { MessageRouterService } from '../services/messageRouter';
import type { UserProfile, Peer, Message } from '../models/session';

/**
 * Dashboard state for WebView
 */
interface DashboardState {
  isAuthenticated: boolean;
  profile: UserProfile | null;
  connectionState: string;
  connectedPeers: Peer[];
  recentMessages: Message[];
  unreadCount: number;
}

/**
 * Dashboard WebView Provider
 * 
 * Provides the sidebar dashboard view for the extension.
 */
export class DashboardViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = VIEWS.DASHBOARD;

  private readonly log = logger.createChildLogger('DashboardView');
  private view?: vscode.WebviewView;
  
  private readonly authService: AuthService;
  private readonly peerService: PeerService;
  private readonly messageRouter: MessageRouterService;
  private readonly extensionUri: vscode.Uri;

  constructor(
    extensionUri: vscode.Uri,
    authService: AuthService,
    peerService: PeerService,
    messageRouter: MessageRouterService
  ) {
    this.extensionUri = extensionUri;
    this.authService = authService;
    this.peerService = peerService;
    this.messageRouter = messageRouter;
  }

  /**
   * Resolve the WebView
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.log.info('Resolving dashboard webview');
    
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from WebView
    webviewView.webview.onDidReceiveMessage(
      this.handleWebviewMessage.bind(this)
    );

    // Subscribe to state changes
    this.subscribeToStateChanges();

    // Initial state update
    this.updateState();
  }

  /**
   * Refresh the dashboard
   */
  public refresh(): void {
    this.updateState();
  }

  /**
   * Subscribe to state change events
   */
  private subscribeToStateChanges(): void {
    // Auth state changes
    this.authService.onAuthEvent(() => {
      this.updateState();
    });

    // Peer state changes
    this.peerService.onPeerEvent(() => {
      this.updateState();
    });

    // Message events
    this.messageRouter.onMessageEvent(() => {
      this.updateState();
    });
  }

  /**
   * Update WebView state
   */
  private updateState(): void {
    if (!this.view) {
      return;
    }

    const state = this.getDashboardState();
    this.view.webview.postMessage({
      type: WEBVIEW_MESSAGES.UPDATE_STATE,
      payload: state,
    });
  }

  /**
   * Get current dashboard state
   */
  private getDashboardState(): DashboardState {
    const connectedPeers = this.peerService.getConnectedPeers();
    const recentMessages = this.messageRouter.getRecentMessages(5);
    const profile = this.authService.getProfile();
    
    // Calculate unread count
    const unreadCount = recentMessages.filter(
      m => m.recipientId === profile?.id && !m.isRead
    ).length;

    return {
      isAuthenticated: this.authService.isAuthenticated(),
      profile: profile,
      connectionState: this.peerService.getConnectionState(),
      connectedPeers,
      recentMessages,
      unreadCount,
    };
  }

  /**
   * Handle messages from WebView
   */
  private async handleWebviewMessage(message: { type: string; payload?: any }): Promise<void> {
    this.log.info('Received webview message', { type: message.type });

    switch (message.type) {
      case WEBVIEW_MESSAGES.GET_STATE:
        this.updateState();
        break;

      case WEBVIEW_MESSAGES.CONNECT_PEER:
        await vscode.commands.executeCommand(
          COMMANDS.CONNECT, 
          message.payload?.peerId
        );
        break;

      case WEBVIEW_MESSAGES.DISCONNECT_PEER:
        await this.peerService.disconnectFromPeer(message.payload?.peerId);
        this.updateState();
        break;

      case WEBVIEW_MESSAGES.REFRESH_PEERS:
        await this.peerService.discoverPeers();
        this.updateState();
        break;

      case WEBVIEW_MESSAGES.SEND_MESSAGE:
        await vscode.commands.executeCommand(
          COMMANDS.SEND_MESSAGE,
          message.payload?.peerId,
          message.payload?.content
        );
        break;

      case 'login':
        this.log.info('Login button clicked, executing connect command');
        try {
          await vscode.commands.executeCommand(COMMANDS.CONNECT);
          this.log.info('Connect command executed successfully');
        } catch (error) {
          this.log.error('Connect command failed', error as Error);
        }
        break;

      case 'logout':
        this.log.info('Logout button clicked');
        await this.authService.logout();
        vscode.window.showInformationMessage('Successfully signed out');
        this.updateState();
        break;

      case 'clearHistory':
        this.log.info('Clear history button clicked');
        await this.messageRouter.clearHistory();
        vscode.window.showInformationMessage('Chat history cleared');
        this.updateState();
        break;

      case 'openChat':
        await vscode.commands.executeCommand('peerSync.openChat', message.payload?.peerId);
        break;

      default:
        this.log.warn('Unknown webview message type', { type: message.type });
    }
  }

  /**
   * Get HTML content for the WebView
   */
  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();

    // Get resource URIs
    const welcomeGifUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'welcome_gif.json')
    );
    const searchGifUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'search.json')
    );
    const peopleIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'people.png')
    );
    const chatIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'chat.png')
    );
    const aiGifUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'AI.gif')
    );
    const logoutIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'logout.png')
    );
    const noInternetUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'no_internet_connection.json')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; img-src ${webview.cspSource} https: data:; connect-src https:;">
  <title>PeerSync Dashboard</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js" nonce="${nonce}"></script>
  <style>
    :root {
      --container-padding: 16px;
      --input-padding: 8px;
      --border-radius: 6px;
    }
    
    * {
      box-sizing: border-box;
    }
    
    body {
      padding: 0;
      margin: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
    }
    
    .container {
      padding: var(--container-padding);
    }
    
    .section {
      margin-bottom: 20px;
    }
    
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-sideBarSectionHeader-foreground);
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    
    .profile-card {
      display: flex;
      align-items: center;
      padding: 12px;
      background: var(--vscode-sideBar-dropBackground);
      border-radius: var(--border-radius);
      margin-bottom: 12px;
    }
    
    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--vscode-button-background);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: bold;
      color: var(--vscode-button-foreground);
      margin-right: 12px;
    }
    
    .profile-info {
      flex: 1;
    }
    
    .profile-name {
      font-weight: 600;
      margin-bottom: 2px;
    }
    
    .profile-role {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
    }
    
    .status-connected {
      background: rgba(40, 167, 69, 0.2);
      color: #28a745;
    }
    
    .status-disconnected {
      background: rgba(220, 53, 69, 0.2);
      color: #dc3545;
    }
    
    .status-connecting {
      background: rgba(255, 193, 7, 0.2);
      color: #ffc107;
    }
    
    .peer-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    
    .peer-item {
      display: flex;
      align-items: center;
      padding: 8px;
      border-radius: var(--border-radius);
      cursor: pointer;
      transition: background 0.15s;
    }
    
    .peer-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
    .peer-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--vscode-badge-background);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      color: var(--vscode-badge-foreground);
      margin-right: 10px;
      position: relative;
    }
    
    .online-indicator {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      border: 2px solid var(--vscode-sideBar-background);
    }
    
    .online-indicator.online { background: #28a745; }
    .online-indicator.away { background: #ffc107; }
    .online-indicator.busy { background: #dc3545; }
    .online-indicator.offline { background: #6c757d; }
    
    .peer-info {
      flex: 1;
      min-width: 0;
    }
    
    .peer-name {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .peer-status {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    
    /* ═══════════════════════════════════════════════════════════════════════════
       LAN MODE ADDITION – SAFE EXTENSION
       LAN badge styling for peers on the same network
       ═══════════════════════════════════════════════════════════════════════════ */
    .lan-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      background: rgba(40, 167, 69, 0.2);
      color: #28a745;
      border-radius: 10px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      margin-left: 6px;
      flex-shrink: 0;
    }
    
    .lan-badge::before {
      content: '●';
      font-size: 6px;
    }
    /* ═══════════════════════════════════════════════════════════════════════════ */
    
    .message-preview {
      padding: 8px;
      background: var(--vscode-editor-background);
      border-radius: var(--border-radius);
      margin-bottom: 8px;
      border-left: 3px solid var(--vscode-activityBarBadge-background);
    }
    
    .message-sender {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    
    .message-content {
      font-size: 12px;
      color: var(--vscode-foreground);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .message-time {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
    }
    
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 8px 16px;
      border: none;
      border-radius: var(--border-radius);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      width: 100%;
    }
    
    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }
    
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .empty-state {
      text-align: center;
      padding: 24px 16px;
      color: var(--vscode-descriptionForeground);
    }
    
    .empty-state-icon {
      width: 80px;
      height: 80px;
      margin: 0 auto 12px;
    }
    
    .empty-state-icon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    
    .lottie-container {
      width: 280px;
      height: 280px;
      margin: 0 auto 28px;
    }
    
    /* Theme-aware: invert colors for dark themes */
    body.vscode-dark .lottie-container,
    body.vscode-high-contrast .lottie-container {
      filter: invert(1) hue-rotate(180deg);
    }
    
    /* Also apply to empty state images in dark mode */
    body.vscode-dark .empty-state-icon img,
    body.vscode-high-contrast .empty-state-icon img {
      filter: invert(1) hue-rotate(180deg);
      opacity: 0.9;
    }
    
    /* Theme-aware logout button icon */
    body.vscode-dark .logout-btn img,
    body.vscode-high-contrast .logout-btn img {
      filter: invert(1) hue-rotate(180deg);
    }
    
    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
    }
    
    .section-header .section-title {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }
    
    .clear-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    
    .clear-btn:hover {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    
    .empty-state-text {
      font-size: 13px;
      margin-bottom: 16px;
    }
    
    .logout-btn {
      background: transparent;
      border: none;
      cursor: pointer;
      padding: 4px;
      opacity: 0.7;
      transition: opacity 0.15s;
    }
    
    .logout-btn:hover {
      opacity: 1;
    }
    
    .logout-btn img {
      width: 20px;
      height: 20px;
    }
    
    .unread-badge {
      background: var(--vscode-activityBarBadge-background);
      color: var(--vscode-activityBarBadge-foreground);
      border-radius: 10px;
      padding: 2px 6px;
      font-size: 10px;
      font-weight: 600;
    }
    
    .login-container {
      padding: 24px 16px;
      text-align: center;
    }
    
    .login-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    
    .login-description {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 20px;
    }
  </style>
</head>
<body>
  <div class="container" id="app">
    <!-- Content will be rendered by JavaScript -->
  </div>
  
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      
      // Resource URIs
      const resources = {
        welcomeGif: '${welcomeGifUri}',
        searchGif: '${searchGifUri}',
        peopleIcon: '${peopleIconUri}',
        chatIcon: '${chatIconUri}',
        aiGif: '${aiGifUri}',
        logoutIcon: '${logoutIconUri}',
        noInternet: '${noInternetUri}'
      };
      
      // Lottie animations cache
      const lottieAnimations = {};
      
      // State
      let state = {
        isAuthenticated: false,
        profile: null,
        connectionState: 'disconnected',
        connectedPeers: [],
        recentMessages: [],
        unreadCount: 0
      };
      
      // Request initial state
      vscode.postMessage({ type: 'getState' });
      
      // Listen for state updates
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'updateState') {
          state = message.payload;
          render();
        }
      });
      
      // Render function
      function render() {
        const app = document.getElementById('app');
        
        if (!state.isAuthenticated) {
          app.innerHTML = renderLoginView();
        } else {
          app.innerHTML = renderDashboard();
        }
        
        attachEventListeners();
      }
      
      // Render login view
      function renderLoginView() {
        return \`
          <div class="login-container">
            <div class="lottie-container" id="welcomeLottie"></div>
            <div class="login-title">Welcome to PeerSync</div>
            <div class="login-description">
              Connect with your team members and collaborate in real-time with AI-powered assistance.
            </div>
            <button class="btn btn-primary" id="loginBtn">
              Sign In to Get Started
            </button>
          </div>
        \`;
      }
      
      // Initialize Lottie animation
      function initLottie(containerId, animationPath) {
        const container = document.getElementById(containerId);
        if (container && typeof lottie !== 'undefined') {
          // Destroy existing animation if any
          if (lottieAnimations[containerId]) {
            lottieAnimations[containerId].destroy();
          }
          lottieAnimations[containerId] = lottie.loadAnimation({
            container: container,
            renderer: 'svg',
            loop: true,
            autoplay: true,
            path: animationPath
          });
        }
      }
      
      // Render dashboard
      function renderDashboard() {
        return \`
          \${renderProfileSection()}
          \${renderConnectionSection()}
          \${renderPeersSection()}
          \${renderRecentChatsSection()}
        \`;
      }
      
      // Render profile section
      function renderProfileSection() {
        const profile = state.profile;
        if (!profile) return '';
        
        const initials = profile.displayName
          .split(' ')
          .map(n => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2);
        
        return \`
          <div class="section">
            <div class="profile-card">
              <div class="avatar">\${initials}</div>
              <div class="profile-info">
                <div class="profile-name">\${escapeHtml(profile.displayName)}</div>
                <div class="profile-role">\${getRoleLabel(profile.role)}</div>
              </div>
              <button class="logout-btn" id="logoutBtn" title="Sign Out">
                <img src="\${resources.logoutIcon}" alt="Logout" />
              </button>
            </div>
          </div>
        \`;
      }
      
      // Render connection section
      function renderConnectionSection() {
        const statusClass = state.connectionState === 'connected' 
          ? 'status-connected' 
          : state.connectionState === 'connecting'
          ? 'status-connecting'
          : 'status-disconnected';
        
        const statusText = state.connectionState === 'connected'
          ? 'Connected'
          : state.connectionState === 'connecting'
          ? 'Connecting...'
          : 'Disconnected';
        
        return \`
          <div class="section">
            <div class="section-title">Network Status</div>
            <div style="display: flex; align-items: center; justify-content: space-between;">
              <span class="status-badge \${statusClass}">\${statusText}</span>
              \${state.connectionState !== 'connected' 
                ? '<button class="btn btn-secondary" style="width: auto; padding: 4px 12px; font-size: 11px;" id="connectBtn">Connect</button>'
                : '<button class="btn btn-secondary" style="width: auto; padding: 4px 12px; font-size: 11px;" id="refreshBtn">Refresh</button>'
              }
            </div>
          </div>
        \`;
      }
      
      // Render peers section
      function renderPeersSection() {
        const peers = state.connectedPeers;
        
        return \`
          <div class="section">
            <div class="section-title">Connected Peers (\${peers.length})</div>
            \${peers.length === 0 
              ? \`
                <div class="empty-state">
                  <div class="empty-state-icon">
                    <img src="\${resources.peopleIcon}" alt="People" />
                  </div>
                  <div class="empty-state-text">No peers connected</div>
                  <button class="btn btn-primary" id="findPeersBtn">
                    Find Peers
                  </button>
                </div>
              \`
              : \`
                <ul class="peer-list">
                  \${peers.map(peer => renderPeerItem(peer)).join('')}
                </ul>
              \`
            }
          </div>
        \`;
      }
      
      // Render peer item
      function renderPeerItem(peer) {
        const initials = peer.profile.displayName
          .split(' ')
          .map(n => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2);
        
        // ═══════════════════════════════════════════════════════════════════════
        // LAN MODE ADDITION – SAFE EXTENSION
        // Show LAN badge for peers on the same network
        // ═══════════════════════════════════════════════════════════════════════
        const lanBadge = peer.connectionMode === 'LAN' 
          ? '<span class="lan-badge">LAN</span>' 
          : '';
        // ═══════════════════════════════════════════════════════════════════════
        
        return \`
          <li class="peer-item" data-peer-id="\${peer.id}">
            <div class="peer-avatar">
              \${initials}
              <span class="online-indicator \${peer.profile.status}"></span>
            </div>
            <div class="peer-info">
              <div class="peer-name">\${escapeHtml(peer.profile.displayName)}\${lanBadge}</div>
              <div class="peer-status">\${getRoleLabel(peer.profile.role)}</div>
            </div>
            \${peer.unreadCount > 0 
              ? \`<span class="unread-badge">\${peer.unreadCount}</span>\`
              : ''
            }
          </li>
        \`;
      }
      
      // Render recent chats section
      function renderRecentChatsSection() {
        const messages = state.recentMessages;
        
        if (messages.length === 0) {
          return '';
        }
        
        return \`
          <div class="section">
            <div class="section-header">
              <div class="section-title">Recent Messages</div>
              <button class="clear-btn" id="clearHistoryBtn" title="Clear History">Clear</button>
            </div>
            \${messages.slice(0, 3).map(msg => renderMessagePreview(msg)).join('')}
          </div>
        \`;
      }
      
      // Render message preview
      function renderMessagePreview(message) {
        const peer = state.connectedPeers.find(p => p.id === message.senderId);
        const senderName = peer?.profile.displayName || 'Unknown';
        
        return \`
          <div class="message-preview" data-sender-id="\${message.senderId}">
            <div class="message-sender">\${escapeHtml(senderName)}</div>
            <div class="message-content">\${escapeHtml(message.content.substring(0, 50))}\${message.content.length > 50 ? '...' : ''}</div>
            <div class="message-time">\${formatTime(message.createdAt)}</div>
          </div>
        \`;
      }
      
      // Helper functions
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      function getRoleLabel(role) {
        const labels = {
          frontend: 'Frontend Developer',
          backend: 'Backend Developer',
          fullstack: 'Full Stack Developer',
          devops: 'DevOps Engineer',
          other: 'Developer'
        };
        return labels[role] || 'Developer';
      }
      
      function formatTime(isoString) {
        const date = new Date(isoString);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 60000) return 'Just now';
        if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
        return date.toLocaleDateString();
      }
      
      // Attach event listeners after render
      function attachEventListeners() {
        // Initialize Lottie animations
        if (document.getElementById('welcomeLottie')) {
          initLottie('welcomeLottie', resources.welcomeGif);
        }
        if (document.getElementById('searchLottie')) {
          initLottie('searchLottie', resources.searchGif);
        }
        if (document.getElementById('noInternetLottie')) {
          initLottie('noInternetLottie', resources.noInternet);
        }
        
        // Login button
        const loginBtn = document.getElementById('loginBtn');
        if (loginBtn) {
          loginBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'login' });
          });
        }
        
        // Logout button
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
          logoutBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'logout' });
          });
        }
        
        // Connect button
        const connectBtn = document.getElementById('connectBtn');
        if (connectBtn) {
          connectBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'connectPeer' });
          });
        }
        
        // Find peers button
        const findPeersBtn = document.getElementById('findPeersBtn');
        if (findPeersBtn) {
          findPeersBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'connectPeer' });
          });
        }
        
        // Refresh button
        const refreshBtn = document.getElementById('refreshBtn');
        if (refreshBtn) {
          refreshBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'refreshPeers' });
          });
        }
        
        // Clear history button
        const clearHistoryBtn = document.getElementById('clearHistoryBtn');
        if (clearHistoryBtn) {
          clearHistoryBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'clearHistory' });
          });
        }
        
        // Peer items - open chat
        const peerItems = document.querySelectorAll('.peer-item[data-peer-id]');
        peerItems.forEach(item => {
          item.addEventListener('click', () => {
            const peerId = item.getAttribute('data-peer-id');
            if (peerId) {
              vscode.postMessage({ type: 'openChat', payload: { peerId } });
            }
          });
        });
        
        // Message previews - open chat
        const messagePreviews = document.querySelectorAll('.message-preview[data-sender-id]');
        messagePreviews.forEach(item => {
          item.addEventListener('click', () => {
            const senderId = item.getAttribute('data-sender-id');
            if (senderId) {
              vscode.postMessage({ type: 'openChat', payload: { peerId: senderId } });
            }
          });
        });
      }
      
      // Initial render
      render();
    })();
  </script>
</body>
</html>`;
  }

  /**
   * Generate a nonce for CSP
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
