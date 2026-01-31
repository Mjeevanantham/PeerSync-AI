/**
 * PeerSync Dev Connect - Chat WebView
 * 
 * Real-time chat interface with AI integration features.
 * Supports message validation, AI prompt insertion, and response capture.
 * 
 * TODO: [ ] Rich text / markdown rendering
 * TODO: [ ] Code syntax highlighting
 * TODO: [ ] File attachment preview
 * TODO: [ ] Emoji picker
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { WEBVIEW_MESSAGES, COMMANDS } from '../utils/constants';
import { AuthService } from '../services/authService';
import { PeerService } from '../services/peerService';
import { MessageRouterService } from '../services/messageRouter';
import type { UserProfile, Peer, Message, ChatThread } from '../models/session';

/**
 * Chat state for WebView
 */
interface ChatState {
  currentUserId: string | null;
  peer: Peer | null;
  messages: Message[];
  isTyping: boolean;
  connectionState: string;
}

/**
 * Chat WebView Panel
 * 
 * Provides a full chat interface as a webview panel.
 */
export class ChatViewPanel {
  public static currentPanel: ChatViewPanel | undefined;
  private static readonly viewType = 'peerSync.chatView';

  private readonly log = logger.createChildLogger('ChatView');
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly authService: AuthService;
  private readonly peerService: PeerService;
  private readonly messageRouter: MessageRouterService;
  
  private peerId: string | null = null;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    authService: AuthService,
    peerService: PeerService,
    messageRouter: MessageRouterService
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.authService = authService;
    this.peerService = peerService;
    this.messageRouter = messageRouter;

    // Set up the webview
    this.panel.webview.html = this.getHtmlContent();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      this.handleWebviewMessage.bind(this),
      null,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables
    );

    // Subscribe to message events
    this.subscribeToEvents();
  }

  /**
   * Create or show the chat panel
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    authService: AuthService,
    peerService: PeerService,
    messageRouter: MessageRouterService,
    peerId?: string
  ): ChatViewPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it
    if (ChatViewPanel.currentPanel) {
      ChatViewPanel.currentPanel.panel.reveal(column);
      if (peerId) {
        ChatViewPanel.currentPanel.loadChat(peerId);
      }
      return ChatViewPanel.currentPanel;
    }

    // Create a new panel
    const panel = vscode.window.createWebviewPanel(
      ChatViewPanel.viewType,
      'PeerSync Chat',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    ChatViewPanel.currentPanel = new ChatViewPanel(
      panel,
      extensionUri,
      authService,
      peerService,
      messageRouter
    );

    if (peerId) {
      ChatViewPanel.currentPanel.loadChat(peerId);
    }

    return ChatViewPanel.currentPanel;
  }

  /**
   * Load chat with a specific peer
   */
  public loadChat(peerId: string): void {
    this.peerId = peerId;
    const peer = this.peerService.getPeer(peerId);
    
    if (peer) {
      this.panel.title = `Chat with ${peer.profile.displayName}`;
    }
    
    this.updateState();
    
    // Mark messages as read
    const profile = this.authService.getProfile();
    if (profile) {
      const threadId = this.createThreadId(profile.id, peerId);
      this.messageRouter.markMessagesAsRead(threadId);
    }
  }

  /**
   * Subscribe to message and peer events
   */
  private subscribeToEvents(): void {
    // Message events
    const messageDisposable = this.messageRouter.onMessageEvent((event, message) => {
      if (this.peerId && 
          (message.senderId === this.peerId || message.recipientId === this.peerId)) {
        this.updateState();
      }
    });

    // Peer events
    const peerDisposable = this.peerService.onPeerEvent((event, data) => {
      if (this.peerId) {
        this.updateState();
      }
    });

    this.disposables.push(messageDisposable, peerDisposable);
  }

  /**
   * Update WebView state
   */
  private updateState(): void {
    const state = this.getChatState();
    this.panel.webview.postMessage({
      type: WEBVIEW_MESSAGES.UPDATE_STATE,
      payload: state,
    });
  }

  /**
   * Get current chat state
   */
  private getChatState(): ChatState {
    const profile = this.authService.getProfile();
    const peer = this.peerId ? this.peerService.getPeer(this.peerId) ?? null : null;
    const thread = this.peerId && profile
      ? this.messageRouter.getThread(this.peerId)
      : null;

    return {
      currentUserId: profile?.id || null,
      peer,
      messages: thread?.messages || [],
      isTyping: false,
      connectionState: peer?.connectionState || 'disconnected',
    };
  }

  /**
   * Handle messages from WebView
   */
  private async handleWebviewMessage(message: { type: string; payload?: any }): Promise<void> {
    this.log.info('Received chat webview message', { type: message.type, payload: message.payload });

    switch (message.type) {
      case WEBVIEW_MESSAGES.GET_STATE:
        this.updateState();
        break;

      case WEBVIEW_MESSAGES.SEND_MESSAGE:
        this.log.info('Send message requested', { peerId: this.peerId, content: message.payload?.content });
        if (this.peerId && message.payload?.content) {
          try {
            const result = await this.messageRouter.sendMessage(
              this.peerId,
              message.payload.content,
              { type: message.payload.type || 'text' }
            );
            this.log.info('Message sent result', { success: !!result });
            // Update the state to show the new message
            this.updateState();
          } catch (error) {
            this.log.error('Failed to send message', error as Error);
            vscode.window.showErrorMessage('Failed to send message');
          }
        } else {
          this.log.warn('Cannot send message - missing peerId or content', { 
            peerId: this.peerId, 
            hasContent: !!message.payload?.content 
          });
          if (!this.peerId) {
            vscode.window.showWarningMessage('No peer selected. Please select a peer to chat with.');
          }
        }
        break;

      case WEBVIEW_MESSAGES.INSERT_TO_AI:
        if (message.payload?.content) {
          await this.messageRouter.insertToIdeAi(message.payload.content, {
            waitForResponse: message.payload.waitForResponse,
          });
        }
        break;

      case 'captureAiResponse':
        if (this.peerId && message.payload?.originalMessageId) {
          const response = await this.messageRouter.captureAiResponse();
          if (response) {
            await this.messageRouter.sendAiResponseToPeer(
              this.peerId,
              response,
              message.payload.originalMessageId
            );
          }
        }
        break;

      case 'sendCode':
        if (this.peerId) {
          const editor = vscode.window.activeTextEditor;
          if (editor && !editor.selection.isEmpty) {
            const code = editor.document.getText(editor.selection);
            const language = editor.document.languageId;
            await this.messageRouter.sendMessage(
              this.peerId,
              `\`\`\`${language}\n${code}\n\`\`\``,
              { type: 'code' }
            );
          } else {
            vscode.window.showInformationMessage('Please select some code first');
          }
        }
        break;

      default:
        this.log.warn('Unknown chat webview message type', { type: message.type });
    }
  }

  /**
   * Create thread ID from two user IDs
   */
  private createThreadId(userId1: string, userId2: string): string {
    const sorted = [userId1, userId2].sort();
    return `thread_${sorted[0]}_${sorted[1]}`;
  }

  /**
   * Get HTML content for the WebView
   */
  private getHtmlContent(): string {
    const nonce = this.getNonce();
    const webview = this.panel.webview;

    // Get resource URIs
    const welcomeGifUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'welcome_gif.json')
    );
    const chatIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'chat.png')
    );
    const aiGifUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'AI.gif')
    );
    const sendIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'send_icon.png')
    );
    const codeIconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'resources', 'code.png')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdnjs.cloudflare.com; img-src ${webview.cspSource} https: data:; connect-src https:;">
  <title>PeerSync Chat</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js" nonce="${nonce}"></script>
  <style>
    :root {
      --message-padding: 10px 12px;
      --border-radius: 8px;
      --header-height: 60px;
      --footer-height: auto;
    }
    
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    
    html, body {
      height: 100%;
      overflow: hidden;
    }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    
    /* Main App Container */
    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }
    
    /* ============ HEADER - FIXED ============ */
    .chat-header {
      display: flex;
      align-items: center;
      padding: 10px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      z-index: 10;
    }
    
    .peer-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--vscode-button-background);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 14px;
      color: var(--vscode-button-foreground);
      margin-right: 12px;
      flex-shrink: 0;
    }
    
    .peer-details {
      flex: 1;
      min-width: 0;
    }
    
    .peer-name {
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    .peer-status {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    /* ═══════════════════════════════════════════════════════════════════════════
       LAN MODE ADDITION – SAFE EXTENSION
       LAN badge styling for chat header
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
    
    .header-actions {
      display: flex;
      gap: 8px;
      flex-shrink: 0;
    }
    
    .icon-btn {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      padding: 8px;
      cursor: pointer;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    
    /* ============ MESSAGES AREA - SCROLLABLE ============ */
    .messages-area {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
    }
    
    .messages-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: auto;
      padding-bottom: 8px;
    }
    
    /* Message Row */
    .message-row {
      display: flex;
      width: 100%;
      animation: fadeIn 0.15s ease-out;
    }
    
    .message-row.sent {
      justify-content: flex-end;
    }
    
    .message-row.received {
      justify-content: flex-start;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    /* Message Bubble */
    .message {
      max-width: 70%;
      min-width: 60px;
    }
    
    .message-bubble {
      padding: var(--message-padding);
      border-radius: var(--border-radius);
      position: relative;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    
    .message-row.sent .message-bubble {
      background: #005c4b;
      color: #e9edef;
      border-top-left-radius: var(--border-radius);
      border-top-right-radius: var(--border-radius);
      border-bottom-left-radius: var(--border-radius);
      border-bottom-right-radius: 0;
    }
    
    .message-row.received .message-bubble {
      background: #202c33;
      color: #e9edef;
      border-top-left-radius: var(--border-radius);
      border-top-right-radius: var(--border-radius);
      border-bottom-right-radius: var(--border-radius);
      border-bottom-left-radius: 0;
    }
    
    .message-content {
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    
    .message-content code {
      background: rgba(0, 0, 0, 0.2);
      padding: 2px 6px;
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }
    
    .message-content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 12px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 8px 0;
    }
    
    .message-content pre code {
      background: transparent;
      padding: 0;
    }
    
    .message-meta {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      margin-top: 4px;
      font-size: 10px;
      opacity: 0.7;
      gap: 4px;
    }
    
    .message-time {
      color: inherit;
    }
    
    .message-status {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    
    .message-status .check {
      color: #34b7f1;
    }
    
    .message-actions {
      display: flex;
      gap: 4px;
      margin-top: 8px;
    }
    
    .message-action-btn {
      background: rgba(255, 255, 255, 0.1);
      border: none;
      color: inherit;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
    }
    
    .message-action-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }
    
    .ai-prompt-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(255, 193, 7, 0.2);
      color: #ffc107;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 10px;
      margin-bottom: 6px;
    }
    
    .ai-response-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(40, 167, 69, 0.2);
      color: #28a745;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 10px;
      margin-bottom: 6px;
    }
    
    /* ============ FOOTER - FIXED ============ */
    .chat-footer {
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      z-index: 10;
    }
    
    .input-actions {
      display: flex;
      gap: 8px;
      padding: 8px 16px 0;
    }
    
    .input-action {
      background: var(--vscode-button-secondaryBackground);
      border: none;
      color: var(--vscode-button-secondaryForeground);
      padding: 5px 10px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    .input-action:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .input-wrapper {
      display: flex;
      gap: 10px;
      padding: 10px 16px 12px;
      align-items: flex-end;
    }
    
    .message-input {
      flex: 1;
      background: #2a3942;
      border: none;
      color: #e9edef;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      resize: none;
      max-height: 100px;
      min-height: 42px;
      line-height: 1.4;
      font-family: inherit;
    }
    
    .message-input:focus {
      outline: none;
    }
    
    .message-input::placeholder {
      color: #8696a0;
    }
    
    .send-btn {
      background: #00a884;
      border: none;
      color: #fff;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.15s;
    }
    
    .send-btn:hover {
      background: #06cf9c;
    }
    
    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    /* Empty State - No peer selected */
    .no-peer-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      padding: 32px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    
    /* Empty State - No messages yet */
    .empty-messages {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      height: 100%;
    }
    
    .empty-state-icon {
      width: 80px;
      height: 80px;
      margin-bottom: 16px;
    }
    
    .empty-state-icon img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    
    .lottie-container {
      width: 150px;
      height: 150px;
      margin-bottom: 16px;
    }
    
    /* Theme-aware: invert colors for dark themes */
    body.vscode-dark .lottie-container,
    body.vscode-high-contrast .lottie-container {
      filter: invert(1) hue-rotate(180deg);
    }
    
    body.vscode-dark .empty-state-icon img,
    body.vscode-high-contrast .empty-state-icon img {
      filter: invert(1) hue-rotate(180deg);
      opacity: 0.9;
    }
    
    .empty-state-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }
    
    .empty-state-text {
      font-size: 13px;
      color: #8696a0;
    }
    
    .ai-icon {
      width: 24px;
      height: 24px;
      vertical-align: middle;
    }
    
    .code-icon {
      width: 20px;
      height: 20px;
      vertical-align: middle;
    }
    
    /* Theme-aware code icon */
    body.vscode-dark .code-icon,
    body.vscode-high-contrast .code-icon {
      filter: invert(1) hue-rotate(180deg);
    }
    
    .send-icon {
      width: 20px;
      height: 20px;
      filter: brightness(0) invert(1);
    }
    
    /* Typing Indicator */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    
    .typing-dots {
      display: flex;
      gap: 4px;
    }
    
    .typing-dot {
      width: 6px;
      height: 6px;
      background: var(--vscode-descriptionForeground);
      border-radius: 50%;
      animation: bounce 1.4s infinite ease-in-out;
    }
    
    .typing-dot:nth-child(1) { animation-delay: -0.32s; }
    .typing-dot:nth-child(2) { animation-delay: -0.16s; }
    
    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }
  </style>
</head>
<body>
  <div id="app">
    <!-- Content rendered by JavaScript -->
  </div>
  
  <script nonce="${nonce}">
    (function() {
      const vscode = acquireVsCodeApi();
      
      // Resource URIs
      const resources = {
        welcomeGif: '${welcomeGifUri}',
        chatIcon: '${chatIconUri}',
        aiGif: '${aiGifUri}',
        sendIcon: '${sendIconUri}',
        codeIcon: '${codeIconUri}'
      };
      
      // Lottie animations cache
      const lottieAnimations = {};
      
      // Initialize Lottie animation
      function initLottie(containerId, animationPath) {
        const container = document.getElementById(containerId);
        if (container && typeof lottie !== 'undefined') {
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
      
      let state = {
        currentUserId: null,
        peer: null,
        messages: [],
        isTyping: false,
        connectionState: 'disconnected'
      };
      
      // Request initial state
      vscode.postMessage({ type: 'getState' });
      
      // Listen for state updates
      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'updateState') {
          state = message.payload;
          render();
          scrollToBottom();
        } else if (message.type === 'newMessage') {
          // Handle new message
          state.messages.push(message.payload);
          render();
          scrollToBottom();
        }
      });
      
      function render() {
        const app = document.getElementById('app');
        
        if (!state.peer) {
          app.innerHTML = renderNoPeerState();
          return;
        }
        
        app.innerHTML = \`
          \${renderHeader()}
          \${renderMessagesArea()}
          \${renderFooter()}
        \`;
        
        attachEventListeners();
      }
      
      function renderNoPeerState() {
        return \`
          <div class="no-peer-state">
            <div class="empty-state-icon">
              <img src="\${resources.chatIcon}" alt="Chat" />
            </div>
            <div class="empty-state-title">No Chat Selected</div>
            <div class="empty-state-text">
              Select a peer from the dashboard to start chatting
            </div>
          </div>
        \`;
      }
      
      function renderHeader() {
        const peer = state.peer;
        const initials = peer.profile.displayName
          .split(' ')
          .map(n => n[0])
          .join('')
          .toUpperCase()
          .slice(0, 2);
        
        const statusText = state.connectionState === 'connected' 
          ? 'Online' 
          : 'Offline';
        
        // ═══════════════════════════════════════════════════════════════════════
        // LAN MODE ADDITION – SAFE EXTENSION
        // Show LAN indicator in chat header
        // ═══════════════════════════════════════════════════════════════════════
        const lanIndicator = peer.connectionMode === 'LAN'
          ? '<span class="lan-badge">LAN</span>'
          : '';
        // ═══════════════════════════════════════════════════════════════════════
        
        return \`
          <div class="chat-header">
            <div class="peer-avatar">\${initials}</div>
            <div class="peer-details">
              <div class="peer-name">\${escapeHtml(peer.profile.displayName)}\${lanIndicator}</div>
              <div class="peer-status">\${statusText}</div>
            </div>
            <div class="header-actions">
              <button class="icon-btn" id="sendCodeBtn" title="Send Code Selection">
                <img src="\${resources.codeIcon}" alt="Code" class="code-icon" />
              </button>
              <button class="icon-btn" id="insertToAiBtn" title="Insert to AI">
                <img src="\${resources.aiGif}" alt="AI" class="ai-icon" />
              </button>
            </div>
          </div>
        \`;
      }
      
      function renderMessagesArea() {
        if (state.messages.length === 0) {
          setTimeout(() => initLottie('startChatLottie', resources.welcomeGif), 100);
          return \`
            <div class="messages-area" id="messagesContainer">
              <div class="empty-messages">
                <div class="lottie-container" id="startChatLottie"></div>
                <div class="empty-state-title">Start the Conversation</div>
                <div class="empty-state-text">
                  Send a message to begin collaborating
                </div>
              </div>
            </div>
          \`;
        }
        
        return \`
          <div class="messages-area" id="messagesContainer">
            <div class="messages-list">
              \${state.messages.map(msg => renderMessage(msg)).join('')}
              \${state.isTyping ? renderTypingIndicator() : ''}
            </div>
          </div>
        \`;
      }
      
      function renderMessage(message) {
        const isSent = message.senderId === state.currentUserId;
        const rowClass = isSent ? 'sent' : 'received';
        
        let badge = '';
        if (message.type === 'ai-prompt') {
          badge = '<div class="ai-prompt-badge"><img src="' + resources.aiGif + '" alt="AI" class="ai-icon" style="width:14px;height:14px;"/> AI Prompt</div>';
        } else if (message.type === 'ai-response') {
          badge = '<div class="ai-response-badge"><img src="' + resources.aiGif + '" alt="AI" class="ai-icon" style="width:14px;height:14px;"/> AI Response</div>';
        }
        
        let actions = '';
        if (!isSent && message.type === 'ai-prompt') {
          actions = \`
            <div class="message-actions">
              <button class="message-action-btn" data-action="insertToAi" data-msg-id="\${message.id}" data-content="\${escapeHtml(message.content)}">
                <img src="\${resources.aiGif}" alt="AI" style="width:12px;height:12px;vertical-align:middle;margin-right:4px;"/>Insert to AI
              </button>
              <button class="message-action-btn" data-action="captureReply" data-msg-id="\${message.id}">
                Capture & Reply
              </button>
            </div>
          \`;
        }
        
        // Double check marks for sent messages
        const checkMark = isSent ? \`
          <span class="message-status">
            <span class="check">✓</span>\${message.isRead ? '<span class="check">✓</span>' : ''}
          </span>
        \` : '';
        
        return \`
          <div class="message-row \${rowClass}">
            <div class="message">
              <div class="message-bubble">
                \${badge}
                <div class="message-content">\${formatContent(message.content)}</div>
                <div class="message-meta">
                  <span class="message-time">\${formatTime(message.createdAt)}</span>
                  \${checkMark}
                </div>
                \${actions}
              </div>
            </div>
          </div>
        \`;
      }
      
      function renderTypingIndicator() {
        return \`
          <div class="typing-indicator">
            <span>\${state.peer?.profile.displayName} is typing</span>
            <div class="typing-dots">
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
              <span class="typing-dot"></span>
            </div>
          </div>
        \`;
      }
      
      function renderFooter() {
        return \`
          <div class="chat-footer">
            <div class="input-actions">
              <button class="input-action" id="sendAsPromptBtn">
                <img src="\${resources.aiGif}" alt="AI" class="ai-icon" style="width:16px;height:16px;"/> Send as AI Prompt
              </button>
              <button class="input-action" id="sendCodeBtn2">
                <img src="\${resources.codeIcon}" alt="Code" class="code-icon" style="width:16px;height:16px;"/> Send Code
              </button>
            </div>
            <div class="input-wrapper">
              <textarea 
                class="message-input" 
                id="messageInput"
                placeholder="Type a message..."
                rows="1"
              ></textarea>
              <button class="send-btn" id="sendBtn" title="Send">
                <img src="\${resources.sendIcon}" alt="Send" class="send-icon" />
              </button>
            </div>
          </div>
        \`;
      }
      
      function formatContent(content) {
        // Basic markdown-like formatting
        let formatted = escapeHtml(content);
        
        // Code blocks
        formatted = formatted.replace(
          /\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,
          '<pre><code>$2</code></pre>'
        );
        
        // Inline code
        formatted = formatted.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        
        return formatted;
      }
      
      function formatTime(isoString) {
        const date = new Date(isoString);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      
      function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
      }
      
      function escapeJs(text) {
        return text.replace(/'/g, "\\'").replace(/\\n/g, '\\\\n');
      }
      
      function scrollToBottom() {
        setTimeout(() => {
          const container = document.getElementById('messagesContainer');
          if (container) {
            container.scrollTop = container.scrollHeight;
          }
        }, 100);
      }
      
      function attachEventListeners() {
        const input = document.getElementById('messageInput');
        const sendBtn = document.getElementById('sendBtn');
        
        if (input) {
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          });
          
          // Auto-resize textarea
          input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
          });
        }
        
        if (sendBtn) {
          sendBtn.addEventListener('click', sendMessage);
        }
        
        // Send as AI prompt button
        const sendAsPromptBtn = document.getElementById('sendAsPromptBtn');
        if (sendAsPromptBtn) {
          sendAsPromptBtn.addEventListener('click', handleSendAsPrompt);
        }
        
        // Send code buttons
        const sendCodeBtn = document.getElementById('sendCodeBtn');
        if (sendCodeBtn) {
          sendCodeBtn.addEventListener('click', handleSendCode);
        }
        const sendCodeBtn2 = document.getElementById('sendCodeBtn2');
        if (sendCodeBtn2) {
          sendCodeBtn2.addEventListener('click', handleSendCode);
        }
        
        // Insert to AI button
        const insertToAiBtn = document.getElementById('insertToAiBtn');
        if (insertToAiBtn) {
          insertToAiBtn.addEventListener('click', handleInsertToAi);
        }
        
        // Message action buttons (dynamically created)
        document.querySelectorAll('[data-action="insertToAi"]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const msgId = btn.getAttribute('data-msg-id');
            const content = btn.getAttribute('data-content');
            if (content) {
              handleInsertMessageToAi(msgId, content);
            }
          });
        });
        
        document.querySelectorAll('[data-action="captureReply"]').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const msgId = btn.getAttribute('data-msg-id');
            if (msgId) {
              handleCaptureAndReply(msgId);
            }
          });
        });
      }
      
      function sendMessage(type = 'text') {
        const input = document.getElementById('messageInput');
        const content = input?.value.trim();
        
        if (!content) return;
        
        vscode.postMessage({
          type: 'sendMessage',
          payload: { content, type }
        });
        
        input.value = '';
        input.style.height = 'auto';
      }
      
      // Event handlers
      function handleSendAsPrompt() {
        const input = document.getElementById('messageInput');
        const content = input?.value.trim();
        if (content) {
          vscode.postMessage({
            type: 'sendMessage',
            payload: { content, type: 'ai-prompt' }
          });
          input.value = '';
        }
      }
      
      function handleSendCode() {
        vscode.postMessage({ type: 'sendCode' });
      }
      
      function handleInsertToAi() {
        const input = document.getElementById('messageInput');
        const content = input?.value.trim();
        if (content) {
          vscode.postMessage({
            type: 'insertToAi',
            payload: { content, waitForResponse: false }
          });
        }
      }
      
      function handleInsertMessageToAi(messageId, content) {
        vscode.postMessage({
          type: 'insertToAi',
          payload: { content, waitForResponse: true, messageId }
        });
      }
      
      function handleCaptureAndReply(originalMessageId) {
        vscode.postMessage({
          type: 'captureAiResponse',
          payload: { originalMessageId }
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

  /**
   * Dispose of the panel
   */
  public dispose(): void {
    ChatViewPanel.currentPanel = undefined;

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}

/**
 * Open chat command registration
 */
export function registerOpenChatCommand(
  context: vscode.ExtensionContext,
  authService: AuthService,
  peerService: PeerService,
  messageRouter: MessageRouterService
): vscode.Disposable {
  return vscode.commands.registerCommand('peerSync.openChat', (peerId?: string) => {
    ChatViewPanel.createOrShow(
      context.extensionUri,
      authService,
      peerService,
      messageRouter,
      peerId
    );
  });
}
