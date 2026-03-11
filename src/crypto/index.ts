/**
 * PeerSync Dev Connect - Crypto Module
 *
 * Public API for the end-to-end encryption subsystem.
 */

export { EncryptionService } from './encryptionService';
export {
  ENCRYPTION_VERSION,
  EncryptionError,
  type KeyPair,
  type RawKeyPair,
  type EncryptedPayload,
  type PeerEncryptionState,
  type EncryptionConfig,
  type EncryptionErrorType,
  type EncryptedMessage,
  type KeyExchangeStatus,
} from './types';
