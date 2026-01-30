/**
 * PeerSync Dev Connect - Peer Protocol
 * 
 * Defines the communication protocol for peer-to-peer messaging.
 * This module handles message serialization, protocol versioning,
 * and communication patterns.
 * 
 * TODO: [ ] WebRTC / Gateway integration
 * TODO: [ ] End-to-end encryption
 * TODO: [ ] Protocol negotiation for different IDE capabilities
 */

import type { Message, UserProfile, FileContext } from '../models/session';

/**
 * Protocol version for compatibility checking
 */
export const PROTOCOL_VERSION = '1.0.0';

/**
 * Protocol message types
 */
export enum ProtocolMessageType {
  // Connection lifecycle
  HANDSHAKE = 'handshake',
  HANDSHAKE_ACK = 'handshake_ack',
  PING = 'ping',
  PONG = 'pong',
  DISCONNECT = 'disconnect',
  
  // Peer discovery
  PEER_ANNOUNCE = 'peer_announce',
  PEER_QUERY = 'peer_query',
  PEER_RESPONSE = 'peer_response',
  
  // Messaging
  CHAT_MESSAGE = 'chat_message',
  MESSAGE_ACK = 'message_ack',
  MESSAGE_READ = 'message_read',
  TYPING_INDICATOR = 'typing_indicator',
  
  // AI integration
  AI_PROMPT_REQUEST = 'ai_prompt_request',
  AI_RESPONSE = 'ai_response',
  AI_INSERT_REQUEST = 'ai_insert_request',
  AI_INSERT_ACK = 'ai_insert_ack',
  
  // File sharing (future)
  FILE_SHARE_REQUEST = 'file_share_request',
  FILE_SHARE_RESPONSE = 'file_share_response',
  FILE_CHUNK = 'file_chunk',
  
  // Error handling
  ERROR = 'error',
}

/**
 * Base protocol message structure
 */
export interface ProtocolMessage<T = unknown> {
  /** Protocol version */
  version: string;
  /** Message type */
  type: ProtocolMessageType;
  /** Unique message identifier */
  id: string;
  /** Sender identifier */
  senderId: string;
  /** Recipient identifier (null for broadcast) */
  recipientId: string | null;
  /** Message timestamp */
  timestamp: string;
  /** Message payload */
  payload: T;
  /** Message signature for verification */
  signature?: string;
}

/**
 * Handshake payload for connection establishment
 */
export interface HandshakePayload {
  /** User profile */
  profile: UserProfile;
  /** Supported protocol version */
  protocolVersion: string;
  /** IDE information */
  ideInfo: IdeInfo;
  /** Supported capabilities */
  capabilities: Capabilities;
  /** Public key for E2E encryption (TODO) */
  publicKey?: string;
}

/**
 * IDE information for cross-IDE compatibility
 */
export interface IdeInfo {
  /** IDE name (vscode, cursor, windsurf, etc.) */
  name: string;
  /** IDE version */
  version: string;
  /** Extension version */
  extensionVersion: string;
  /** Platform (darwin, win32, linux) */
  platform: string;
}

/**
 * Peer capabilities for feature negotiation
 */
export interface Capabilities {
  /** Supports chat messages */
  chat: boolean;
  /** Supports AI integration */
  aiIntegration: boolean;
  /** Supports file sharing */
  fileSharing: boolean;
  /** Supports code snippets */
  codeSnippets: boolean;
  /** Supports screen sharing (future) */
  screenSharing: boolean;
  /** Supports voice chat (future) */
  voiceChat: boolean;
}

/**
 * Chat message payload
 */
export interface ChatMessagePayload {
  /** The message content */
  message: Message;
  /** Thread identifier */
  threadId: string;
  /** Whether this is a reply */
  isReply: boolean;
  /** Original message ID if reply */
  replyToId?: string;
}

/**
 * AI prompt request payload
 */
export interface AiPromptRequestPayload {
  /** The prompt to send to AI */
  prompt: string;
  /** Context from the requesting peer */
  context?: string;
  /** File context if applicable */
  fileContext?: FileContext;
  /** Whether to insert directly to IDE AI */
  insertToIde: boolean;
  /** Request options */
  options?: AiRequestOptions;
}

/**
 * AI request options
 */
export interface AiRequestOptions {
  /** Maximum response length */
  maxTokens?: number;
  /** Temperature for AI responses */
  temperature?: number;
  /** Model preference (if applicable) */
  modelPreference?: string;
}

/**
 * AI response payload
 */
export interface AiResponsePayload {
  /** The AI-generated response */
  response: string;
  /** Original prompt ID */
  promptId: string;
  /** Response metadata */
  metadata?: {
    model?: string;
    tokensUsed?: number;
    processingTime?: number;
  };
}

/**
 * Error payload
 */
export interface ErrorPayload {
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Related message ID */
  relatedMessageId?: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

/**
 * Typing indicator payload
 */
export interface TypingIndicatorPayload {
  /** Thread identifier */
  threadId: string;
  /** Whether user is typing */
  isTyping: boolean;
}

/**
 * Protocol message factory
 */
export class ProtocolMessageFactory {
  private readonly senderId: string;
  private readonly ideInfo: IdeInfo;

  constructor(senderId: string, ideInfo: IdeInfo) {
    this.senderId = senderId;
    this.ideInfo = ideInfo;
  }

  /**
   * Create a protocol message with common fields
   */
  private createMessage<T>(
    type: ProtocolMessageType,
    recipientId: string | null,
    payload: T
  ): ProtocolMessage<T> {
    return {
      version: PROTOCOL_VERSION,
      type,
      id: this.generateMessageId(),
      senderId: this.senderId,
      recipientId,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return `proto_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Create a handshake message
   */
  public createHandshake(
    recipientId: string,
    profile: UserProfile,
    capabilities: Capabilities
  ): ProtocolMessage<HandshakePayload> {
    return this.createMessage(ProtocolMessageType.HANDSHAKE, recipientId, {
      profile,
      protocolVersion: PROTOCOL_VERSION,
      ideInfo: this.ideInfo,
      capabilities,
    });
  }

  /**
   * Create a chat message
   */
  public createChatMessage(
    recipientId: string,
    message: Message,
    threadId: string,
    replyToId?: string
  ): ProtocolMessage<ChatMessagePayload> {
    return this.createMessage(ProtocolMessageType.CHAT_MESSAGE, recipientId, {
      message,
      threadId,
      isReply: !!replyToId,
      replyToId,
    });
  }

  /**
   * Create an AI prompt request
   */
  public createAiPromptRequest(
    recipientId: string,
    prompt: string,
    insertToIde: boolean,
    context?: string,
    fileContext?: FileContext,
    options?: AiRequestOptions
  ): ProtocolMessage<AiPromptRequestPayload> {
    return this.createMessage(ProtocolMessageType.AI_PROMPT_REQUEST, recipientId, {
      prompt,
      context,
      fileContext,
      insertToIde,
      options,
    });
  }

  /**
   * Create an AI response
   */
  public createAiResponse(
    recipientId: string,
    response: string,
    promptId: string,
    metadata?: AiResponsePayload['metadata']
  ): ProtocolMessage<AiResponsePayload> {
    return this.createMessage(ProtocolMessageType.AI_RESPONSE, recipientId, {
      response,
      promptId,
      metadata,
    });
  }

  /**
   * Create an error message
   */
  public createError(
    recipientId: string,
    code: string,
    message: string,
    relatedMessageId?: string,
    details?: Record<string, unknown>
  ): ProtocolMessage<ErrorPayload> {
    return this.createMessage(ProtocolMessageType.ERROR, recipientId, {
      code,
      message,
      relatedMessageId,
      details,
    });
  }

  /**
   * Create a typing indicator
   */
  public createTypingIndicator(
    recipientId: string,
    threadId: string,
    isTyping: boolean
  ): ProtocolMessage<TypingIndicatorPayload> {
    return this.createMessage(ProtocolMessageType.TYPING_INDICATOR, recipientId, {
      threadId,
      isTyping,
    });
  }

  /**
   * Create a ping message
   */
  public createPing(recipientId: string): ProtocolMessage<Record<string, never>> {
    return this.createMessage(ProtocolMessageType.PING, recipientId, {});
  }

  /**
   * Create a pong message
   */
  public createPong(recipientId: string): ProtocolMessage<Record<string, never>> {
    return this.createMessage(ProtocolMessageType.PONG, recipientId, {});
  }

  /**
   * Create a disconnect message
   */
  public createDisconnect(recipientId: string | null): ProtocolMessage<Record<string, never>> {
    return this.createMessage(ProtocolMessageType.DISCONNECT, recipientId, {});
  }
}

/**
 * Protocol message parser and validator
 */
export class ProtocolMessageParser {
  /**
   * Parse a raw message into a protocol message
   */
  public parse<T>(raw: string): ProtocolMessage<T> | null {
    try {
      const parsed = JSON.parse(raw) as ProtocolMessage<T>;
      
      if (!this.validate(parsed)) {
        return null;
      }
      
      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Validate a protocol message structure
   */
  public validate(message: unknown): message is ProtocolMessage {
    if (!message || typeof message !== 'object') {
      return false;
    }

    const msg = message as Record<string, unknown>;

    return (
      typeof msg.version === 'string' &&
      typeof msg.type === 'string' &&
      typeof msg.id === 'string' &&
      typeof msg.senderId === 'string' &&
      (msg.recipientId === null || typeof msg.recipientId === 'string') &&
      typeof msg.timestamp === 'string' &&
      msg.payload !== undefined
    );
  }

  /**
   * Check if protocol versions are compatible
   */
  public isCompatibleVersion(version: string): boolean {
    const [major] = version.split('.');
    const [currentMajor] = PROTOCOL_VERSION.split('.');
    return major === currentMajor;
  }

  /**
   * Serialize a protocol message to string
   */
  public serialize<T>(message: ProtocolMessage<T>): string {
    return JSON.stringify(message);
  }
}

/**
 * Default capabilities for this extension
 */
export const DEFAULT_CAPABILITIES: Capabilities = {
  chat: true,
  aiIntegration: true,
  fileSharing: false, // TODO: [ ] File sharing implementation
  codeSnippets: true,
  screenSharing: false, // TODO: Future feature
  voiceChat: false, // TODO: Future feature
};

/**
 * Get IDE info for the current environment
 */
export function getIdeInfo(extensionVersion: string): IdeInfo {
  // TODO: [ ] Cursor native API support for better IDE detection
  const vscodeVersion = require('vscode').version;
  
  return {
    name: 'vscode', // Will be updated when Cursor API is available
    version: vscodeVersion,
    extensionVersion,
    platform: process.platform,
  };
}
