/**
 * PeerSync Dev Connect - Session Models
 * 
 * Data models for user sessions, peer connections, and messages.
 * These interfaces define the core data structures used throughout the extension.
 */

import type { ConnectionState } from '../utils/constants';

/**
 * User profile information
 */
export interface UserProfile {
  /** Unique user identifier */
  id: string;
  /** Display name */
  displayName: string;
  /** Email address */
  email: string;
  /** Profile avatar URL */
  avatarUrl?: string;
  /** User's role (frontend/backend/fullstack) */
  role: UserRole;
  /** Current online status */
  status: UserStatus;
  /** User's preferred IDE */
  preferredIde?: string;
  /** Account creation timestamp */
  createdAt: string;
  /** Last activity timestamp */
  lastActiveAt: string;
}

/**
 * User roles
 */
export type UserRole = 'frontend' | 'backend' | 'fullstack' | 'devops' | 'other';

/**
 * User online status
 */
export type UserStatus = 'online' | 'away' | 'busy' | 'offline';

/**
 * Authentication tokens
 */
export interface AuthTokens {
  /** JWT access token */
  accessToken: string;
  /** Refresh token for obtaining new access tokens */
  refreshToken: string;
  /** Access token expiration timestamp (ISO string) */
  expiresAt: string;
}

/**
 * User session containing authentication and profile data
 */
export interface Session {
  /** Whether the user is authenticated */
  isAuthenticated: boolean;
  /** User's profile information */
  profile: UserProfile | null;
  /** Authentication tokens */
  tokens: AuthTokens | null;
  /** Session creation timestamp */
  createdAt: string;
  /** Last refresh timestamp */
  lastRefreshedAt: string;
}

/**
 * Peer connection information
 */
export interface Peer {
  /** Unique peer identifier */
  id: string;
  /** Peer's user profile */
  profile: UserProfile;
  /** Current connection state */
  connectionState: ConnectionState;
  /** Connection established timestamp */
  connectedAt?: string;
  /** Last message timestamp */
  lastMessageAt?: string;
  /** Unread message count */
  unreadCount: number;
}

/**
 * Message content types
 */
export type MessageType = 'text' | 'code' | 'ai-prompt' | 'ai-response' | 'system';

/**
 * Message validation status
 */
export type ValidationStatus = 'pending' | 'validated' | 'flagged' | 'rejected';

/**
 * Chat message structure
 */
export interface Message {
  /** Unique message identifier */
  id: string;
  /** Sender user ID */
  senderId: string;
  /** Recipient user ID */
  recipientId: string;
  /** Message content */
  content: string;
  /** Message type */
  type: MessageType;
  /** AI validation status */
  validationStatus: ValidationStatus;
  /** Validation details (if any) */
  validationDetails?: ValidationDetails;
  /** Message creation timestamp */
  createdAt: string;
  /** Whether the message has been read */
  isRead: boolean;
  /** Original message ID (for responses) */
  replyToId?: string;
  /** Message metadata */
  metadata?: MessageMetadata;
}

/**
 * AI validation details
 */
export interface ValidationDetails {
  /** Whether content passed security scan */
  isSecure: boolean;
  /** Security issues found (if any) */
  securityIssues?: string[];
  /** Improved/sanitized content suggestion */
  improvedContent?: string;
  /** Enriched context for AI prompt */
  enrichedContext?: string;
  /** Validation timestamp */
  validatedAt: string;
}

/**
 * Message metadata for additional context
 */
export interface MessageMetadata {
  /** Source IDE */
  sourceIde?: string;
  /** File context (if any) */
  fileContext?: FileContext;
  /** Code language (for code messages) */
  codeLanguage?: string;
  /** Whether inserted to IDE AI */
  insertedToAi?: boolean;
  /** AI response captured */
  aiResponseCaptured?: boolean;
}

/**
 * File context for code-related messages
 */
export interface FileContext {
  /** File path */
  filePath: string;
  /** File name */
  fileName: string;
  /** Selected line range */
  lineRange?: {
    start: number;
    end: number;
  };
  /** Programming language */
  language: string;
}

/**
 * Chat thread between two peers
 */
export interface ChatThread {
  /** Thread identifier (combination of both peer IDs) */
  id: string;
  /** Participating peer IDs */
  participants: [string, string];
  /** Messages in the thread */
  messages: Message[];
  /** Thread creation timestamp */
  createdAt: string;
  /** Last activity timestamp */
  lastActivityAt: string;
  /** Whether the thread is active */
  isActive: boolean;
}

/**
 * Connection request from a peer
 */
export interface ConnectionRequest {
  /** Request identifier */
  id: string;
  /** Requesting peer's profile */
  fromPeer: UserProfile;
  /** Request message */
  message?: string;
  /** Request timestamp */
  requestedAt: string;
  /** Request status */
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
}

/**
 * Session state for the extension
 */
export interface SessionState {
  /** Current user session */
  session: Session | null;
  /** Connected peers */
  peers: Map<string, Peer>;
  /** Active chat threads */
  threads: Map<string, ChatThread>;
  /** Pending connection requests */
  pendingRequests: ConnectionRequest[];
  /** Current connection state */
  connectionState: ConnectionState;
  /** Last sync timestamp */
  lastSyncAt: string | null;
}

/**
 * Factory function to create an empty session
 */
export function createEmptySession(): Session {
  return {
    isAuthenticated: false,
    profile: null,
    tokens: null,
    createdAt: new Date().toISOString(),
    lastRefreshedAt: new Date().toISOString(),
  };
}

/**
 * Factory function to create initial session state
 */
export function createInitialSessionState(): SessionState {
  return {
    session: null,
    peers: new Map(),
    threads: new Map(),
    pendingRequests: [],
    connectionState: 'disconnected',
    lastSyncAt: null,
  };
}

/**
 * Factory function to create a new message
 */
export function createMessage(
  senderId: string,
  recipientId: string,
  content: string,
  type: MessageType = 'text'
): Message {
  return {
    id: generateMessageId(),
    senderId,
    recipientId,
    content,
    type,
    validationStatus: 'pending',
    createdAt: new Date().toISOString(),
    isRead: false,
  };
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Type guard to check if a session is authenticated
 */
export function isAuthenticatedSession(session: Session | null): session is Session & {
  isAuthenticated: true;
  profile: UserProfile;
  tokens: AuthTokens;
} {
  return session !== null && 
         session.isAuthenticated && 
         session.profile !== null && 
         session.tokens !== null;
}

/**
 * Type guard to check if tokens are expired
 */
export function areTokensExpired(tokens: AuthTokens): boolean {
  const expiresAt = new Date(tokens.expiresAt);
  const now = new Date();
  // Add 5 minute buffer before expiration
  const bufferMs = 5 * 60 * 1000;
  return now.getTime() >= expiresAt.getTime() - bufferMs;
}
