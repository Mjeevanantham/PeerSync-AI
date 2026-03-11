/**
 * PeerSync Dev Connect - Crypto Types
 *
 * Type definitions for end-to-end encryption.
 * Uses X25519 for key exchange and XChaCha20-Poly1305 for symmetric encryption.
 */

/**
 * Encryption algorithm version
 * Increment when changing encryption implementation
 */
export const ENCRYPTION_VERSION = 1;

/**
 * Key pair for X25519 key exchange
 */
export interface KeyPair {
  /** Base64-encoded public key (32 bytes) */
  publicKey: string;
  /** Base64-encoded private key (32 bytes) - stored securely */
  privateKey: string;
  /** Key creation timestamp */
  createdAt: string;
  /** Key version for future rotation */
  version: number;
}

/**
 * Raw key pair (binary form)
 */
export interface RawKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Encrypted message payload
 */
export interface EncryptedPayload {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded nonce (24 bytes for XChaCha20-Poly1305) */
  nonce: string;
  /** Encryption version */
  version: number;
  /** Timestamp when encrypted */
  timestamp: string;
}

/**
 * Key exchange status for a peer
 */
export type KeyExchangeStatus = 'none' | 'pending' | 'complete' | 'failed';

/**
 * Peer encryption state
 */
export interface PeerEncryptionState {
  /** Peer's public key (received during connection) */
  publicKey?: string;
  /** Derived shared secret (computed locally) */
  sharedSecret?: string;
  /** Key exchange status */
  status: KeyExchangeStatus;
  /** When key exchange was completed */
  exchangedAt?: string;
}

/**
 * Encryption configuration
 */
export interface EncryptionConfig {
  /** Whether encryption is enabled */
  enabled: boolean;
  /** Whether to require encryption (fail if peer doesn't support it) */
  required: boolean;
  /** Current encryption version */
  version: number;
}

/**
 * Encryption error types
 */
export type EncryptionErrorType =
  | 'key_not_found'
  | 'key_exchange_failed'
  | 'encryption_failed'
  | 'decryption_failed'
  | 'invalid_payload'
  | 'version_mismatch'
  | 'peer_not_supported';

/**
 * Encryption error
 */
export class EncryptionError extends Error {
  constructor(
    public readonly type: EncryptionErrorType,
    message: string,
    public readonly originalError?: Error
  ) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/**
 * Message with encryption metadata
 */
export interface EncryptedMessage {
  /** Message ID */
  id: string;
  /** Sender's public key (for ephemeral keys in future) */
  senderPublicKey?: string;
  /** Encrypted payload */
  encrypted: EncryptedPayload;
  /** Whether this message was successfully decrypted */
  decrypted?: boolean;
  /** Decryption error if any */
  decryptionError?: string;
}