/**
 * PeerSync Dev Connect - Message Router Service
 * 
 * Handles message routing between peers via WebSocket backend.
 * Manages AI validation pipeline and IDE AI integration.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { 
  STORAGE_KEYS,
  DEFAULTS 
} from '../utils/constants';
import type { 
  Message, 
  ChatThread, 
  FileContext,
  ValidationDetails 
} from '../models/session';
import { createMessage } from '../models/session';
import { AuthService } from './authService';
import { PeerService } from './peerService';
import { AiValidatorService, type ValidationResult } from './aiValidator';
import {
  getWebSocketProtocol,
  type WebSocketPeerProtocol,
  type ProtocolEventType,
  type MessageReceivedPayload,
} from '../protocols/WebSocketPeerProtocol';

/**
 * Message event types
 */
export type MessageEventType = 
  | 'message_sent'
  | 'message_received'
  | 'message_validated'
  | 'ai_response_received'
  | 'message_failed';

/**
 * Message event listener
 */
export type MessageEventListener = (
  event: MessageEventType,
  message: Message,
  metadata?: Record<string, unknown>
) => void;

/**
 * Send message options
 */
export interface SendMessageOptions {
  skipValidation?: boolean;
  type?: Message['type'];
  fileContext?: FileContext;
  replyToId?: string;
  insertToAi?: boolean;
  correlationId?: string;
}

/**
 * AI insert options
 */
export interface AiInsertOptions {
  waitForResponse?: boolean;
  responseTimeout?: number;
  customContext?: string;
}

/**
 * Message Router Service
 */
export class MessageRouterService {
  private readonly context: vscode.ExtensionContext;
  private readonly authService: AuthService;
  private readonly peerService: PeerService;
  private readonly aiValidator: AiValidatorService;
  private readonly log = logger.createChildLogger('MessageRouter');
  
  private protocol: WebSocketPeerProtocol;
  private protocolSubscription: vscode.Disposable | null = null;
  
  private readonly listeners: Set<MessageEventListener> = new Set();
  private readonly threads: Map<string, ChatThread> = new Map();
  
  // Correlation tracking for AI responses
  private readonly pendingCorrelations: Map<string, {
    originalMessageId: string;
    senderId: string;
    timestamp: number;
  }> = new Map();

  constructor(
    context: vscode.ExtensionContext,
    authService: AuthService,
    peerService: PeerService,
    aiValidator: AiValidatorService
  ) {
    this.context = context;
    this.authService = authService;
    this.peerService = peerService;
    this.aiValidator = aiValidator;
    this.protocol = getWebSocketProtocol();
  }

  /**
   * Initialize the message router
   */
  public async initialize(): Promise<void> {
    this.log.info('Initializing message router');
    
    // Subscribe to protocol events for incoming messages
    this.protocolSubscription = this.protocol.onEvent(
      (event, data) => this.handleProtocolEvent(event, data)
    );

    // Load persisted chat history
    await this.loadChatHistory();
  }

  /**
   * Send a message to a peer
   */
  public async sendMessage(
    recipientId: string,
    content: string,
    options: SendMessageOptions = {}
  ): Promise<Message | null> {
    const profile = this.authService.getProfile();
    if (!profile) {
      this.log.warn('Cannot send message - not authenticated');
      return null;
    }

    // Get current session ID
    const sessionId = this.peerService.getCurrentSessionId();
    if (!sessionId) {
      this.log.warn('Cannot send message - no active session');
      vscode.window.showWarningMessage('No active session. Please connect to a peer first.');
      return null;
    }

    this.log.info('Sending message', { recipientId, type: options.type, sessionId });

    // Create message
    const message = createMessage(
      profile.id,
      recipientId,
      content,
      options.type || 'text'
    );

    // Add metadata
    if (options.fileContext) {
      message.metadata = {
        ...message.metadata,
        fileContext: options.fileContext,
      };
    }

    if (options.replyToId) {
      message.replyToId = options.replyToId;
    }

    // Generate correlation ID for tracking
    const correlationId = options.correlationId || `cor_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    // Validate message if enabled
    if (!options.skipValidation && this.aiValidator.isValidationEnabled()) {
      const validationResult = await this.aiValidator.validateMessage(message);
      
      message.validationStatus = validationResult.isValid ? 'validated' : 'flagged';
      message.validationDetails = this.createValidationDetails(validationResult);

      if (validationResult.improvedContent) {
        message.content = validationResult.improvedContent;
      } else {
        message.content = validationResult.sanitizedContent;
      }

      if (!validationResult.isValid && validationResult.securityIssues.length > 0) {
        const proceed = await this.promptUserForFlaggedMessage(validationResult.securityIssues);
        if (!proceed) {
          return null;
        }
      }

      this.notifyListeners('message_validated', message, { validationResult });
    } else {
      message.validationStatus = 'validated';
    }

    try {
      // Send via WebSocket protocol
      this.protocol.sendMessage(
        sessionId,
        {
          messageId: message.id,
          content: message.content,
          type: message.type,
          replyToId: message.replyToId,
          metadata: message.metadata,
        },
        message.type,
        correlationId
      );

      // Track correlation for AI responses
      if (message.type === 'ai-prompt') {
        this.pendingCorrelations.set(correlationId, {
          originalMessageId: message.id,
          senderId: profile.id,
          timestamp: Date.now(),
        });
      }

      // Store in thread
      this.addMessageToThread(message);
      
      // Persist chat history
      await this.saveChatHistory();
      
      this.notifyListeners('message_sent', message);

      // Insert to AI if requested
      if (options.insertToAi) {
        await this.insertToIdeAi(message.content, {
          waitForResponse: true,
        });
      }

      return message;
    } catch (error) {
      this.log.error('Failed to send message', error as Error);
      this.notifyListeners('message_failed', message, { error });
      return null;
    }
  }

  /**
   * Handle protocol events
   */
  private handleProtocolEvent(event: ProtocolEventType, data: unknown): void {
    if (event === 'message_received') {
      this.handleIncomingMessage(data as MessageReceivedPayload);
    }
  }

  /**
   * Handle incoming message from WebSocket
   */
  private async handleIncomingMessage(payload: MessageReceivedPayload): Promise<void> {
    this.log.info('Received message', { 
      from: payload.from, 
      sessionId: payload.sessionId,
      type: payload.type 
    });

    const profile = this.authService.getProfile();
    if (!profile) {
      return;
    }

    // Parse content
    const messageContent = payload.content as {
      messageId?: string;
      content?: string;
      type?: string;
      replyToId?: string;
      metadata?: Record<string, unknown>;
    };

    // Create message object
    const message: Message = {
      id: messageContent.messageId || `msg_${Date.now()}`,
      senderId: payload.from,
      recipientId: profile.id,
      content: typeof messageContent.content === 'string' 
        ? messageContent.content 
        : JSON.stringify(messageContent.content),
      type: (payload.type || messageContent.type || 'text') as Message['type'],
      validationStatus: 'pending',
      createdAt: payload.timestamp || new Date().toISOString(),
      isRead: false,
      replyToId: messageContent.replyToId,
      metadata: messageContent.metadata,
    };

    // Validate incoming message for security
    if (this.aiValidator.isValidationEnabled()) {
      const validationResult = await this.aiValidator.validateMessage(message);
      message.validationStatus = validationResult.isValid ? 'validated' : 'flagged';
      message.validationDetails = this.createValidationDetails(validationResult);
    } else {
      message.validationStatus = 'validated';
    }

    // Check if this is an AI response
    if (message.type === 'ai-response' && payload.correlationId) {
      const pending = this.pendingCorrelations.get(payload.correlationId);
      if (pending) {
        message.replyToId = pending.originalMessageId;
        this.pendingCorrelations.delete(payload.correlationId);
        this.notifyListeners('ai_response_received', message, { correlationId: payload.correlationId });
      }
    }

    // Store in thread
    this.addMessageToThread(message);
    
    // Update unread count for the peer
    const peer = this.peerService.getPeer(payload.from);
    if (peer) {
      peer.unreadCount = (peer.unreadCount || 0) + 1;
      peer.lastMessageAt = new Date().toISOString();
    }

    // Persist
    await this.saveChatHistory();

    this.notifyListeners('message_received', message, { 
      sessionId: payload.sessionId 
    });

    // Show notification
    this.showMessageNotification(message);
  }

  /**
   * Send AI response back to peer
   */
  public async sendAiResponseToPeer(
    peerId: string,
    response: string,
    originalMessageId: string,
    correlationId?: string
  ): Promise<Message | null> {
    return this.sendMessage(peerId, response, {
      type: 'ai-response',
      replyToId: originalMessageId,
      correlationId,
    });
  }

  /**
   * Insert content to IDE AI chat
   */
  public async insertToIdeAi(
    content: string,
    options: AiInsertOptions = {}
  ): Promise<string | null> {
    this.log.info('Inserting to IDE AI');

    let enrichedContent = content;
    if (options.customContext) {
      enrichedContent = `${options.customContext}\n\n${content}`;
    }

    // Get current file context
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const selection = editor.selection;
      if (!selection.isEmpty) {
        const selectedText = editor.document.getText(selection);
        enrichedContent = `Selected code:\n\`\`\`\n${selectedText}\n\`\`\`\n\n${enrichedContent}`;
      }
    }

    try {
      const chatExtension = vscode.extensions.getExtension('github.copilot-chat');
      
      if (chatExtension) {
        await vscode.commands.executeCommand(
          'github.copilot.interactiveEditor.explain',
          enrichedContent
        );
      } else {
        await vscode.env.clipboard.writeText(enrichedContent);
        vscode.window.showInformationMessage(
          'Message copied to clipboard. Paste it in your AI chat.',
          'Open Chat'
        ).then(selection => {
          if (selection === 'Open Chat') {
            vscode.commands.executeCommand('workbench.action.chat.open');
          }
        });
      }

      if (options.waitForResponse) {
        const response = await this.captureAiResponse();
        return response;
      }

      return null;
    } catch (error) {
      this.log.error('Failed to insert to IDE AI', error as Error);
      throw error;
    }
  }

  /**
   * Capture AI response from IDE
   */
  public async captureAiResponse(): Promise<string | null> {
    this.log.info('Capturing AI response');

    const response = await vscode.window.showInputBox({
      prompt: 'Paste the AI response here',
      placeHolder: 'AI response...',
      ignoreFocusOut: true,
    });

    return response || null;
  }

  /**
   * Get chat thread with a peer
   */
  public getThread(peerId: string): ChatThread | null {
    const profile = this.authService.getProfile();
    if (!profile) {
      return null;
    }

    const threadId = this.createThreadId(profile.id, peerId);
    return this.threads.get(threadId) || null;
  }

  /**
   * Get all chat threads
   */
  public getAllThreads(): ChatThread[] {
    return Array.from(this.threads.values());
  }

  /**
   * Get recent messages across all threads
   */
  public getRecentMessages(limit: number = 50): Message[] {
    const allMessages: Message[] = [];
    
    this.threads.forEach(thread => {
      allMessages.push(...thread.messages);
    });

    return allMessages
      .sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      .slice(0, limit);
  }

  /**
   * Mark messages as read
   */
  public markMessagesAsRead(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    const profile = this.authService.getProfile();
    if (!profile) {
      return;
    }

    let unreadCount = 0;
    thread.messages.forEach(message => {
      if (message.recipientId === profile.id && !message.isRead) {
        message.isRead = true;
        unreadCount++;
      }
    });

    // Update peer unread count
    const otherParticipant = thread.participants.find(p => p !== profile.id);
    if (otherParticipant) {
      const peer = this.peerService.getPeer(otherParticipant);
      if (peer) {
        peer.unreadCount = Math.max(0, (peer.unreadCount || 0) - unreadCount);
      }
    }

    this.saveChatHistory();
  }

  /**
   * Subscribe to message events
   */
  public onMessageEvent(listener: MessageEventListener): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => {
      this.listeners.delete(listener);
    });
  }

  /**
   * Add message to thread
   */
  private addMessageToThread(message: Message): void {
    const threadId = this.createThreadId(message.senderId, message.recipientId);
    
    let thread = this.threads.get(threadId);
    if (!thread) {
      thread = {
        id: threadId,
        participants: [message.senderId, message.recipientId],
        messages: [],
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        isActive: true,
      };
      this.threads.set(threadId, thread);
    }

    thread.messages.push(message);
    thread.lastActivityAt = new Date().toISOString();

    // Trim old messages
    if (thread.messages.length > DEFAULTS.HISTORY_MAX_ITEMS) {
      thread.messages = thread.messages.slice(-DEFAULTS.HISTORY_MAX_ITEMS);
    }
  }

  /**
   * Create a consistent thread ID
   */
  private createThreadId(userId1: string, userId2: string): string {
    const sorted = [userId1, userId2].sort();
    return `thread_${sorted[0]}_${sorted[1]}`;
  }

  /**
   * Create validation details
   */
  private createValidationDetails(result: ValidationResult): ValidationDetails {
    return {
      isSecure: result.isSecure,
      securityIssues: result.securityIssues.length > 0 
        ? result.securityIssues 
        : undefined,
      improvedContent: result.improvedContent,
      enrichedContext: result.enrichedContext,
      validatedAt: new Date().toISOString(),
    };
  }

  /**
   * Prompt user about flagged message
   */
  private async promptUserForFlaggedMessage(issues: string[]): Promise<boolean> {
    const message = `Security issues detected:\n${issues.join('\n')}\n\nSend anyway?`;
    const result = await vscode.window.showWarningMessage(
      message,
      'Send Anyway',
      'Cancel'
    );
    return result === 'Send Anyway';
  }

  /**
   * Show notification for incoming message
   */
  private showMessageNotification(message: Message): void {
    const peer = this.peerService.getPeer(message.senderId);
    const senderName = peer?.profile.displayName || 'Unknown';

    const typeLabel = message.type === 'ai-response' ? ' (AI Response)' : '';

    vscode.window.showInformationMessage(
      `New message from ${senderName}${typeLabel}`,
      'View'
    ).then(selection => {
      if (selection === 'View') {
        vscode.commands.executeCommand('peerSync.openChat', message.senderId);
      }
    });
  }

  /**
   * Notify listeners
   */
  private notifyListeners(
    event: MessageEventType,
    message: Message,
    metadata?: Record<string, unknown>
  ): void {
    this.listeners.forEach(listener => {
      try {
        listener(event, message, metadata);
      } catch (error) {
        this.log.error('Message event listener error', error as Error);
      }
    });
  }

  /**
   * Load chat history from storage
   */
  private async loadChatHistory(): Promise<void> {
    try {
      const historyJson = this.context.globalState.get<string>(STORAGE_KEYS.CHAT_HISTORY);
      
      if (historyJson) {
        const threads = JSON.parse(historyJson) as ChatThread[];
        threads.forEach(thread => {
          this.threads.set(thread.id, thread);
        });
        this.log.info('Loaded chat history', { threadCount: threads.length });
      }
    } catch (error) {
      this.log.warn('Failed to load chat history', { error });
    }
  }

  /**
   * Save chat history to storage
   */
  private async saveChatHistory(): Promise<void> {
    try {
      const threads = Array.from(this.threads.values());
      await this.context.globalState.update(
        STORAGE_KEYS.CHAT_HISTORY,
        JSON.stringify(threads)
      );
    } catch (error) {
      this.log.warn('Failed to save chat history', { error });
    }
  }

  /**
   * Clear all chat history
   */
  public async clearHistory(): Promise<void> {
    this.threads.clear();
    await this.context.globalState.update(STORAGE_KEYS.CHAT_HISTORY, undefined);
    this.log.info('Chat history cleared');
  }

  /**
   * Clean up old correlations
   */
  private cleanupOldCorrelations(): void {
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();
    
    for (const [id, pending] of this.pendingCorrelations) {
      if (now - pending.timestamp > maxAge) {
        this.pendingCorrelations.delete(id);
      }
    }
  }

  /**
   * Dispose of service resources
   */
  public dispose(): void {
    if (this.protocolSubscription) {
      this.protocolSubscription.dispose();
    }
    this.listeners.clear();
    this.pendingCorrelations.clear();
  }
}
