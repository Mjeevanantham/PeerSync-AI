/**
 * PeerSync Dev Connect - Message Router Service
 * 
 * Handles message routing between peers, AI validation pipeline,
 * and IDE AI integration for inserting prompts and capturing responses.
 * 
 * TODO: [ ] Cursor native API support for direct AI chat integration
 * TODO: [ ] Message queue for offline support
 * TODO: [ ] Message encryption in transit
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { 
  WEBVIEW_MESSAGES, 
  STORAGE_KEYS,
  DEFAULTS 
} from '../utils/constants';
import type {
  Message,
  ChatThread,
  FileContext,
  ValidationDetails,
} from '../models/session';
import { createMessage } from '../models/session';
import { AuthService } from './authService';
import { PeerService } from './peerService';
import { AiValidatorService, type ValidationResult } from './aiValidator';
import type { ChatMessagePayload, AiPromptRequestPayload, AiResponsePayload } from '../protocols/peerProtocol';
import type { MessageReceivedPayload } from '../protocols/WebSocketPeerProtocol';

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
  /** Skip AI validation */
  skipValidation?: boolean;
  /** Message type */
  type?: Message['type'];
  /** File context */
  fileContext?: FileContext;
  /** Reply to message ID */
  replyToId?: string;
  /** Insert to IDE AI after sending */
  insertToAi?: boolean;
}

/**
 * AI insert options
 */
export interface AiInsertOptions {
  /** Wait for AI response */
  waitForResponse?: boolean;
  /** Timeout for response (ms) */
  responseTimeout?: number;
  /** Custom context to include */
  customContext?: string;
}

/**
 * Message Router Service
 * 
 * Manages the message flow: validation -> routing -> delivery -> AI integration.
 */
export class MessageRouterService {
  private readonly context: vscode.ExtensionContext;
  private readonly authService: AuthService;
  private readonly peerService: PeerService;
  private readonly aiValidator: AiValidatorService;
  private readonly log = logger.createChildLogger('MessageRouter');
  
  private readonly listeners: Set<MessageEventListener> = new Set();
  private readonly threads: Map<string, ChatThread> = new Map();
  private readonly pendingAiResponses: Map<string, {
    resolve: (response: string) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
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
  }

  /**
   * Initialize the message router (real-time: subscribe to backend messages).
   */
  public async initialize(): Promise<void> {
    this.log.info('Initializing message router');
    this.peerService.setOnMessageReceived((payload) => this.handleIncomingMessageFromBackend(payload));
    await this.loadChatHistory();
  }

  /**
   * Handle MESSAGE_RECEIVED from backend (production real-time).
   */
  private handleIncomingMessageFromBackend(payload: MessageReceivedPayload): void {
    const profile = this.authService.getProfile();
    if (!profile) return;

    const senderId = payload.from;
    const content = typeof payload.content === 'string' ? payload.content : JSON.stringify(payload.content);
    const message: Message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      senderId,
      recipientId: profile.id,
      content,
      type: (payload.type as Message['type']) || 'text',
      validationStatus: 'validated',
      createdAt: payload.timestamp || new Date().toISOString(),
      isRead: false,
      replyToId: undefined,
    };

    this.addMessageToThread(message);
    this.notifyListeners('message_received', message, { sessionId: payload.sessionId });
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

    this.log.info('Sending message', { recipientId, type: options.type });

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

    // Validate message
    if (!options.skipValidation && this.aiValidator.isValidationEnabled()) {
      const validationResult = await this.aiValidator.validateMessage(message);
      
      message.validationStatus = validationResult.isValid ? 'validated' : 'flagged';
      message.validationDetails = this.createValidationDetails(validationResult);

      // Use sanitized/improved content
      if (validationResult.improvedContent) {
        message.content = validationResult.improvedContent;
      } else {
        message.content = validationResult.sanitizedContent;
      }

      if (!validationResult.isValid) {
        this.log.warn('Message validation failed', { 
          issues: validationResult.securityIssues 
        });
        
        // Still send but mark as flagged
        if (validationResult.securityIssues.length > 0) {
          const proceed = await this.promptUserForFlaggedMessage(
            validationResult.securityIssues
          );
          if (!proceed) {
            return null;
          }
        }
      }

      this.notifyListeners('message_validated', message, { validationResult });
    } else {
      message.validationStatus = 'validated';
    }

    // Route message to peer
    try {
      await this.routeMessageToPeer(recipientId, message);
      
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
      const msg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`PeerSync: ${msg}`);
      this.notifyListeners('message_failed', message, { error });
      return null;
    }
  }

  /**
   * Handle incoming message from a peer
   */
  public async handleIncomingMessage(
    senderId: string,
    payload: ChatMessagePayload
  ): Promise<void> {
    this.log.info('Received message', { senderId, threadId: payload.threadId });

    const message = payload.message;

    // Validate incoming message for security
    if (this.aiValidator.isValidationEnabled()) {
      const validationResult = await this.aiValidator.validateMessage(message);
      message.validationStatus = validationResult.isValid ? 'validated' : 'flagged';
      message.validationDetails = this.createValidationDetails(validationResult);
    }

    // Store in thread
    this.addMessageToThread(message);
    
    // Persist
    await this.saveChatHistory();

    this.notifyListeners('message_received', message, { 
      threadId: payload.threadId 
    });

    // Show notification
    this.showMessageNotification(message);
  }

  /**
   * Insert content to IDE AI chat
   * 
   * TODO: [ ] Cursor native API support for direct integration
   */
  public async insertToIdeAi(
    content: string,
    options: AiInsertOptions = {}
  ): Promise<string | null> {
    this.log.info('Inserting to IDE AI');

    // Enrich context if needed
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

    // TODO: [ ] Cursor native API - use native chat API when available
    // For now, we'll use the VS Code chat API or copy to clipboard approach

    try {
      // Attempt to use VS Code's built-in AI chat if available
      const chatExtension = vscode.extensions.getExtension('github.copilot-chat');
      
      if (chatExtension) {
        // Use Copilot Chat API
        await vscode.commands.executeCommand(
          'github.copilot.interactiveEditor.explain',
          enrichedContent
        );
      } else {
        // Fallback: Copy to clipboard and notify user
        await vscode.env.clipboard.writeText(enrichedContent);
        vscode.window.showInformationMessage(
          'Message copied to clipboard. Paste it in your AI chat.',
          'Open Chat'
        ).then(selection => {
          if (selection === 'Open Chat') {
            // Try to open AI chat panel
            vscode.commands.executeCommand('workbench.action.chat.open');
          }
        });
      }

      // If waiting for response
      if (options.waitForResponse) {
        const response = await this.waitForAiResponse(
          options.responseTimeout || 30000
        );
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
   * 
   * TODO: [ ] Cursor native API support for response capture
   */
  public async captureAiResponse(): Promise<string | null> {
    this.log.info('Capturing AI response');

    // TODO: [ ] Implement actual AI response capture
    // This requires IDE-specific integration

    // For now, prompt user to copy response
    const response = await vscode.window.showInputBox({
      prompt: 'Paste the AI response here',
      placeHolder: 'AI response...',
      ignoreFocusOut: true,
    });

    return response || null;
  }

  /**
   * Send AI response back to peer
   */
  public async sendAiResponseToPeer(
    peerId: string,
    response: string,
    originalMessageId: string
  ): Promise<Message | null> {
    return this.sendMessage(peerId, response, {
      type: 'ai-response',
      replyToId: originalMessageId,
    });
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

    thread.messages.forEach(message => {
      if (message.recipientId === profile.id && !message.isRead) {
        message.isRead = true;
      }
    });

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
   * Route message to peer via backend (production: requires real session).
   */
  private async routeMessageToPeer(recipientId: string, message: Message): Promise<void> {
    const sessionId = this.peerService.getSessionIdForPeer(recipientId);
    if (!sessionId) {
      this.log.warn('No session with peer - connect first', { recipientId });
      throw new Error('Not connected to this peer. Send a connection request and wait for acceptance.');
    }

    this.peerService.sendMessage(
      sessionId,
      message.content,
      message.type,
      undefined,
      message.id,
      message.replyToId
    );
    this.log.info('Message sent via backend', { recipientId, messageId: message.id });
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

    // Trim old messages if exceeding limit
    if (thread.messages.length > DEFAULTS.HISTORY_MAX_ITEMS) {
      thread.messages = thread.messages.slice(-DEFAULTS.HISTORY_MAX_ITEMS);
    }
  }

  /**
   * Create a consistent thread ID from two user IDs
   */
  private createThreadId(userId1: string, userId2: string): string {
    const sorted = [userId1, userId2].sort();
    return `thread_${sorted[0]}_${sorted[1]}`;
  }

  /**
   * Create validation details from validation result
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
  private async promptUserForFlaggedMessage(
    issues: string[]
  ): Promise<boolean> {
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

    vscode.window.showInformationMessage(
      `New message from ${senderName}`,
      'View'
    ).then(selection => {
      if (selection === 'View') {
        vscode.commands.executeCommand('peerSync.openChat', message.senderId);
      }
    });
  }

  /**
   * Wait for AI response with timeout
   */
  private waitForAiResponse(timeout: number): Promise<string> {
    const requestId = `ai_${Date.now()}`;
    
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingAiResponses.delete(requestId);
        reject(new Error('AI response timeout'));
      }, timeout);

      this.pendingAiResponses.set(requestId, {
        resolve: (response: string) => {
          clearTimeout(timeoutHandle);
          this.pendingAiResponses.delete(requestId);
          resolve(response);
        },
        reject: (error: Error) => {
          clearTimeout(timeoutHandle);
          this.pendingAiResponses.delete(requestId);
          reject(error);
        },
        timeout: timeoutHandle,
      });

      // Prompt user to capture response
      this.captureAiResponse().then(response => {
        const pending = this.pendingAiResponses.get(requestId);
        if (pending && response) {
          pending.resolve(response);
        } else if (pending) {
          pending.reject(new Error('No response captured'));
        }
      });
    });
  }

  /**
   * Notify listeners of message events
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
      const historyJson = this.context.globalState.get<string>(
        STORAGE_KEYS.CHAT_HISTORY
      );
      
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
   * Dispose of service resources
   */
  public dispose(): void {
    this.pendingAiResponses.forEach(pending => {
      clearTimeout(pending.timeout);
    });
    this.pendingAiResponses.clear();
    this.listeners.clear();
  }
}
