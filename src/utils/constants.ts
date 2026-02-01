/**
 * PeerSync Dev Connect - Constants
 * 
 * Centralized configuration constants for the extension.
 * All configurable values should be defined here.
 */

/**
 * Extension identifier constants
 */
export const EXTENSION_ID = 'peersync-dev-connect';
export const EXTENSION_DISPLAY_NAME = 'PeerSync Dev Connect';

/**
 * Command identifiers
 */
export const COMMANDS = {
  CONNECT: 'peerSync.connect',
  OPEN_DASHBOARD: 'peerSync.openDashboard',
  OPEN_CHAT: 'peerSync.openChat',
  SEND_MESSAGE: 'peerSync.sendMessage',
} as const;

/**
 * View identifiers
 */
export const VIEWS = {
  DASHBOARD: 'peerSync.dashboardView',
  CHAT: 'peerSync.chatView',
} as const;

/**
 * Configuration keys
 */
export const CONFIG_KEYS = {
  SERVER_URL: 'peerSync.serverUrl',
  AUTO_CONNECT: 'peerSync.autoConnect',
  ENABLE_AI_VALIDATION: 'peerSync.enableAiValidation',
  LOG_LEVEL: 'peerSync.logLevel',
  SUPABASE_URL: 'peerSync.supabaseUrl',
  SUPABASE_ANON_KEY: 'peerSync.supabaseAnonKey',
} as const;

/**
 * Supabase configuration
 * These can be overridden via VS Code settings
 */
export const SUPABASE_CONFIG = {
  // Supabase project URL
  URL: 'https://ckgbxjystbrhjehayttg.supabase.co',
  // Supabase anon key (public, safe to expose in frontend)
  ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrZ2J4anlzdGJyaGplaGF5dHRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk4Nzc3MTAsImV4cCI6MjA4NTQ1MzcxMH0.aVJyMqESklvRlqcxT_W8AdzMJD-cDEGi8k9SGaGmopw',
  // OAuth redirect URI scheme (default fallback)
  REDIRECT_SCHEME: 'vscode',
  // Extension ID for callback URL
  EXTENSION_ID: 'peersync.peersync-dev-connect',
} as const;

/** Add all these redirect URLs in Supabase Dashboard → Authentication → URL Configuration */
export const OAUTH_REDIRECT_URLS = [
  'vscode://peersync.peersync-dev-connect/auth/callback',
  'cursor://peersync.peersync-dev-connect/auth/callback',
  'windsurf://peersync.peersync-dev-connect/auth/callback',
  'antigravity://peersync.peersync-dev-connect/auth/callback',
  'code://peersync.peersync-dev-connect/auth/callback',
] as const;

/**
 * Default configuration values
 */
export const DEFAULTS = {
  SERVER_URL: 'https://api-peersync.up.railway.app',
  AUTO_CONNECT: false,
  ENABLE_AI_VALIDATION: true,
  LOG_LEVEL: 'info' as const,
  SESSION_TIMEOUT_MS: 3600000, // 1 hour
  RECONNECT_INTERVAL_MS: 5000,
  MAX_RECONNECT_ATTEMPTS: 5,
  MESSAGE_MAX_LENGTH: 10000,
  HISTORY_MAX_ITEMS: 100,
} as const;

/**
 * Storage keys for persistent data
 */
export const STORAGE_KEYS = {
  SESSION_TOKEN: 'peerSync.sessionToken',
  REFRESH_TOKEN: 'peerSync.refreshToken',
  USER_PROFILE: 'peerSync.userProfile',
  RECENT_PEERS: 'peerSync.recentPeers',
  CHAT_HISTORY: 'peerSync.chatHistory',
  SUPABASE_SESSION: 'peerSync.supabaseSession',
} as const;

/**
 * WebView message types
 */
export const WEBVIEW_MESSAGES = {
  // Outbound (extension -> webview)
  UPDATE_STATE: 'updateState',
  UPDATE_PEERS: 'updatePeers',
  NEW_MESSAGE: 'newMessage',
  CONNECTION_STATUS: 'connectionStatus',
  ERROR: 'error',
  
  // Inbound (webview -> extension)
  CONNECT_PEER: 'connectPeer',
  DISCONNECT_PEER: 'disconnectPeer',
  SEND_MESSAGE: 'sendMessage',
  INSERT_TO_AI: 'insertToAi',
  REFRESH_PEERS: 'refreshPeers',
  GET_STATE: 'getState',
} as const;

/**
 * Connection states
 */
export const CONNECTION_STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
} as const;

/**
 * Log levels
 */
export const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
} as const;

/**
 * API endpoints (relative to server URL)
 */
export const API_ENDPOINTS = {
  AUTH_LOGIN: '/auth/login',
  AUTH_LOGOUT: '/auth/logout',
  AUTH_REFRESH: '/auth/refresh',
  PEERS_LIST: '/peers',
  PEERS_CONNECT: '/peers/connect',
  PEERS_DISCONNECT: '/peers/disconnect',
  MESSAGES_SEND: '/messages/send',
  MESSAGES_HISTORY: '/messages/history',
  AI_VALIDATE: '/ai/validate',
  /** Backend uses global prefix api/v1 */
  NETWORK_GET: '/api/v1/network',
  NETWORK_CREATE: '/api/v1/network',
  NETWORK_JOIN: '/api/v1/network/join',
  NETWORK_LEAVE: '/api/v1/network/leave',
} as const;

/**
 * Error codes
 */
export const ERROR_CODES = {
  AUTH_FAILED: 'AUTH_FAILED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  PEER_NOT_FOUND: 'PEER_NOT_FOUND',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  MESSAGE_FAILED: 'MESSAGE_FAILED',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

// Type exports for type-safe usage
export type CommandId = typeof COMMANDS[keyof typeof COMMANDS];
export type ViewId = typeof VIEWS[keyof typeof VIEWS];
export type ConnectionState = typeof CONNECTION_STATE[keyof typeof CONNECTION_STATE];
export type LogLevel = keyof typeof LOG_LEVELS;
export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];
