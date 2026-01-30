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
    this.log.debug('Received chat webview message', { type: message.type });

    switch (message.type) {
      case WEBVIEW_MESSAGES.GET_STATE:
        this.updateState();
        break;

      case WEBVIEW_MESSAGES.SEND_MESSAGE:
        if (this.peerId && message.payload?.content) {
          await this.messageRouter.sendMessage(
            this.peerId,
            message.payload.content,
            { type: message.payload.type || 'text' }
          );
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

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>PeerSync Chat</title>
  <style>
    :root {
      --message-padding: 12px;
      --border-radius: 12px;
    }
    
    * {
      box-sizing: border-box;
    }
    
    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    
    /* Header */
    .chat-header {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    
    .peer-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--vscode-button-background);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      color: var(--vscode-button-foreground);
      margin-right: 12px;
    }
    
    .peer-details {
      flex: 1;
    }
    
    .peer-name {
      font-weight: 600;
      font-size: 14px;
    }
    
    .peer-status {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    
    .header-actions {
      display: flex;
      gap: 8px;
    }
    
    .icon-btn {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      padding: 6px;
      cursor: pointer;
      border-radius: 4px;
    }
    
    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    
    /* Messages Container */
    .messages-container {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    
    /* Message Bubble */
    .message {
      max-width: 80%;
      animation: fadeIn 0.2s ease;
    }
    
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    
    .message.sent {
      align-self: flex-end;
    }
    
    .message.received {
      align-self: flex-start;
    }
    
    .message-bubble {
      padding: var(--message-padding);
      border-radius: var(--border-radius);
      position: relative;
    }
    
    .message.sent .message-bubble {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-bottom-right-radius: 4px;
    }
    
    .message.received .message-bubble {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-bottom-left-radius: 4px;
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
      justify-content: space-between;
      margin-top: 6px;
      font-size: 10px;
      opacity: 0.7;
    }
    
    .message-time {
      color: inherit;
    }
    
    .message-status {
      display: flex;
      align-items: center;
      gap: 4px;
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
    
    /* Input Area */
    .input-container {
      padding: 12px 16px;
      background: var(--vscode-sideBar-background);
      border-top: 1px solid var(--vscode-panel-border);
    }
    
    .input-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }
    
    .input-action {
      background: var(--vscode-button-secondaryBackground);
      border: none;
      color: var(--vscode-button-secondaryForeground);
      padding: 4px 10px;
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
      gap: 8px;
    }
    
    .message-input {
      flex: 1;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground);
      padding: 10px 14px;
      border-radius: 20px;
      font-size: 13px;
      outline: none;
      resize: none;
      max-height: 120px;
      min-height: 40px;
    }
    
    .message-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    
    .message-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    
    .send-btn {
      background: var(--vscode-button-background);
      border: none;
      color: var(--vscode-button-foreground);
      width: 40px;
      height: 40px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }
    
    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    /* Empty State */
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    
    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    
    .empty-state-title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }
    
    .empty-state-text {
      font-size: 13px;
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
          app.innerHTML = renderEmptyState();
          return;
        }
        
        app.innerHTML = \`
          \${renderHeader()}
          \${renderMessages()}
          \${renderInputArea()}
        \`;
        
        attachEventListeners();
      }
      
      function renderEmptyState() {
        return \`
          <div class="empty-state">
            <div class="empty-state-icon">💬</div>
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
        
        return \`
          <div class="chat-header">
            <div class="peer-avatar">\${initials}</div>
            <div class="peer-details">
              <div class="peer-name">\${escapeHtml(peer.profile.displayName)}</div>
              <div class="peer-status">\${statusText}</div>
            </div>
            <div class="header-actions">
              <button class="icon-btn" title="Send Code Selection" onclick="handleSendCode()">
                📄
              </button>
              <button class="icon-btn" title="Insert to AI" onclick="handleInsertToAi()">
                🤖
              </button>
            </div>
          </div>
        \`;
      }
      
      function renderMessages() {
        if (state.messages.length === 0) {
          return \`
            <div class="messages-container">
              <div class="empty-state">
                <div class="empty-state-icon">👋</div>
                <div class="empty-state-title">Start the Conversation</div>
                <div class="empty-state-text">
                  Send a message to begin collaborating
                </div>
              </div>
            </div>
          \`;
        }
        
        return \`
          <div class="messages-container" id="messagesContainer">
            \${state.messages.map(msg => renderMessage(msg)).join('')}
            \${state.isTyping ? renderTypingIndicator() : ''}
          </div>
        \`;
      }
      
      function renderMessage(message) {
        const isSent = message.senderId === state.currentUserId;
        const messageClass = isSent ? 'sent' : 'received';
        
        let badge = '';
        if (message.type === 'ai-prompt') {
          badge = '<div class="ai-prompt-badge">✨ AI Prompt</div>';
        } else if (message.type === 'ai-response') {
          badge = '<div class="ai-response-badge">🤖 AI Response</div>';
        }
        
        let actions = '';
        if (!isSent && message.type === 'ai-prompt') {
          actions = \`
            <div class="message-actions">
              <button class="message-action-btn" onclick="handleInsertMessageToAi('\${message.id}', '\${escapeJs(message.content)}')">
                Insert to AI
              </button>
              <button class="message-action-btn" onclick="handleCaptureAndReply('\${message.id}')">
                Capture & Reply
              </button>
            </div>
          \`;
        }
        
        return \`
          <div class="message \${messageClass}">
            <div class="message-bubble">
              \${badge}
              <div class="message-content">\${formatContent(message.content)}</div>
              <div class="message-meta">
                <span class="message-time">\${formatTime(message.createdAt)}</span>
                \${isSent ? \`
                  <span class="message-status">
                    \${message.validationStatus === 'validated' ? '✓' : ''}
                  </span>
                \` : ''}
              </div>
              \${actions}
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
      
      function renderInputArea() {
        return \`
          <div class="input-container">
            <div class="input-actions">
              <button class="input-action" onclick="handleSendAsPrompt()">
                ✨ Send as AI Prompt
              </button>
              <button class="input-action" onclick="handleSendCode()">
                📄 Send Code
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
                ➤
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
      
      // Global handlers
      window.handleSendAsPrompt = function() {
        const input = document.getElementById('messageInput');
        const content = input?.value.trim();
        if (content) {
          vscode.postMessage({
            type: 'sendMessage',
            payload: { content, type: 'ai-prompt' }
          });
          input.value = '';
        }
      };
      
      window.handleSendCode = function() {
        vscode.postMessage({ type: 'sendCode' });
      };
      
      window.handleInsertToAi = function() {
        const input = document.getElementById('messageInput');
        const content = input?.value.trim();
        if (content) {
          vscode.postMessage({
            type: 'insertToAi',
            payload: { content, waitForResponse: false }
          });
        }
      };
      
      window.handleInsertMessageToAi = function(messageId, content) {
        vscode.postMessage({
          type: 'insertToAi',
          payload: { content, waitForResponse: true, messageId }
        });
      };
      
      window.handleCaptureAndReply = function(originalMessageId) {
        vscode.postMessage({
          type: 'captureAiResponse',
          payload: { originalMessageId }
        });
      };
      
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
