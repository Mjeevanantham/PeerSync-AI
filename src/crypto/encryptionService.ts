/**
 * PeerSync Dev Connect - Encryption Service
 *
 * Implements end-to-end encryption using NaCl (TweetNaCl):
 * - X25519 key exchange for shared secret derivation
 * - XSalsa20-Poly1305 (nacl.box) for authenticated encryption
 *
 * Key storage is handled via the VS Code SecretStorage API so that
 * private keys are never written to plain-text configuration files.
 */

import * as vscode from 'vscode';
import nacl from 'tweetnacl';
import {
  encodeBase64,
  decodeBase64,
  encodeUTF8,
  decodeUTF8,
} from 'tweetnacl-util';
import { logger } from '../utils/logger';
import type {
  KeyPair,
  RawKeyPair,
  EncryptedPayload,
  PeerEncryptionState,
  EncryptionConfig,
} from './types';
import {
  ENCRYPTION_VERSION,
  EncryptionError,
} from './types';

/** Secret storage key for the local identity key pair */
const SECRET_KEY_STORAGE = 'peerSync.encryption.privateKey';

/**
 * EncryptionService
 *
 * Stateful service that manages:
 *   1. A persistent local key pair (generated once, stored in SecretStorage)
 *   2. Per-peer encryption state (shared secrets derived on key exchange)
 *   3. Encrypt / decrypt helpers used by MessageRouter
 */
export class EncryptionService {
  private readonly log = logger.createChildLogger('Encryption');
  private readonly secrets: vscode.SecretStorage;

  /** The device's identity key pair – loaded on initialise() */
  private localKeyPair: RawKeyPair | null = null;
  private localKeyPairMeta: KeyPair | null = null;

  /** Peer-id → encryption state (in-memory only) */
  private readonly peerStates = new Map<string, PeerEncryptionState>();

  /** Cached raw shared secrets so we don't re-derive on every message */
  private readonly sharedSecrets = new Map<string, Uint8Array>();

  /** Runtime configuration */
  private config: EncryptionConfig = {
    enabled: true,
    required: false,
    version: ENCRYPTION_VERSION,
  };

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  // ──────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────

  /**
   * Initialise the service – loads or generates the identity key pair.
   */
  public async initialize(): Promise<void> {
    this.log.info('Initialising encryption service');

    try {
      const stored = await this.secrets.get(SECRET_KEY_STORAGE);

      if (stored) {
        const parsed = JSON.parse(stored) as KeyPair;
        this.localKeyPair = {
          publicKey: decodeBase64(parsed.publicKey),
          secretKey: decodeBase64(parsed.privateKey),
        };
        this.localKeyPairMeta = parsed;
        this.log.info('Loaded existing key pair', {
          version: parsed.version,
        });
      } else {
        await this.generateAndStoreKeyPair();
      }
    } catch (error) {
      this.log.error('Failed to initialise encryption', error as Error);
      throw new EncryptionError(
        'key_not_found',
        'Could not initialise encryption key pair',
        error as Error,
      );
    }
  }

  /**
   * Dispose – clear sensitive material from memory.
   */
  public dispose(): void {
    // Zero out in-memory secrets
    if (this.localKeyPair) {
      this.localKeyPair.secretKey.fill(0);
    }
    this.sharedSecrets.forEach((secret) => secret.fill(0));
    this.sharedSecrets.clear();
    this.peerStates.clear();
    this.localKeyPair = null;
    this.localKeyPairMeta = null;
    this.log.info('Encryption service disposed');
  }

  // ──────────────────────────────────────────────
  // Key Management
  // ──────────────────────────────────────────────

  /**
   * Get the local public key (base64).
   * This is shared with peers during the key-exchange handshake.
   */
  public getPublicKey(): string | null {
    return this.localKeyPairMeta?.publicKey ?? null;
  }

  /**
   * Regenerate the identity key pair.
   * This invalidates all existing shared secrets with peers.
   */
  public async rotateKeys(): Promise<void> {
    this.log.info('Rotating encryption keys');
    this.sharedSecrets.forEach((s) => s.fill(0));
    this.sharedSecrets.clear();
    this.peerStates.clear();
    await this.generateAndStoreKeyPair();
    this.log.info('Key rotation complete');
  }

  // ──────────────────────────────────────────────
  // Key Exchange
  // ──────────────────────────────────────────────

  /**
   * Process a peer's public key and derive a shared secret.
   *
   * @returns the current peer encryption state
   */
  public deriveSharedSecret(
    peerId: string,
    peerPublicKeyB64: string,
  ): PeerEncryptionState {
    if (!this.localKeyPair) {
      throw new EncryptionError(
        'key_not_found',
        'Local key pair not initialised',
      );
    }

    try {
      const peerPublicKey = decodeBase64(peerPublicKeyB64);

      // nacl.box.before computes the X25519 shared secret
      const sharedSecret = nacl.box.before(
        peerPublicKey,
        this.localKeyPair.secretKey,
      );

      this.sharedSecrets.set(peerId, sharedSecret);

      const state: PeerEncryptionState = {
        publicKey: peerPublicKeyB64,
        sharedSecret: encodeBase64(sharedSecret),
        status: 'complete',
        exchangedAt: new Date().toISOString(),
      };

      this.peerStates.set(peerId, state);
      this.log.info('Shared secret derived', { peerId });
      return state;
    } catch (error) {
      const state: PeerEncryptionState = {
        publicKey: peerPublicKeyB64,
        status: 'failed',
      };
      this.peerStates.set(peerId, state);
      throw new EncryptionError(
        'key_exchange_failed',
        `Key exchange failed for peer ${peerId}`,
        error as Error,
      );
    }
  }

  /**
   * Get the encryption state for a given peer.
   */
  public getPeerState(peerId: string): PeerEncryptionState | undefined {
    return this.peerStates.get(peerId);
  }

  /**
   * Remove all encryption state for a peer (e.g. on disconnect).
   */
  public removePeerState(peerId: string): void {
    const secret = this.sharedSecrets.get(peerId);
    if (secret) {
      secret.fill(0);
      this.sharedSecrets.delete(peerId);
    }
    this.peerStates.delete(peerId);
  }

  // ──────────────────────────────────────────────
  // Encrypt / Decrypt
  // ──────────────────────────────────────────────

  /**
   * Encrypt a plaintext string for a specific peer.
   *
   * Uses nacl.box.after (XSalsa20-Poly1305 with pre-computed shared key).
   */
  public encrypt(peerId: string, plaintext: string): EncryptedPayload {
    const sharedSecret = this.sharedSecrets.get(peerId);
    if (!sharedSecret) {
      throw new EncryptionError(
        'key_not_found',
        `No shared secret for peer ${peerId}. Complete key exchange first.`,
      );
    }

    try {
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const messageBytes = decodeUTF8(plaintext);
      const ciphertext = nacl.box.after(messageBytes, nonce, sharedSecret);

      return {
        ciphertext: encodeBase64(ciphertext),
        nonce: encodeBase64(nonce),
        version: this.config.version,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new EncryptionError(
        'encryption_failed',
        'Failed to encrypt message',
        error as Error,
      );
    }
  }

  /**
   * Decrypt an encrypted payload received from a peer.
   */
  public decrypt(peerId: string, payload: EncryptedPayload): string {
    if (payload.version !== this.config.version) {
      throw new EncryptionError(
        'version_mismatch',
        `Encryption version mismatch: expected ${this.config.version}, got ${payload.version}`,
      );
    }

    const sharedSecret = this.sharedSecrets.get(peerId);
    if (!sharedSecret) {
      throw new EncryptionError(
        'key_not_found',
        `No shared secret for peer ${peerId}. Complete key exchange first.`,
      );
    }

    try {
      const ciphertext = decodeBase64(payload.ciphertext);
      const nonce = decodeBase64(payload.nonce);

      const plaintext = nacl.box.open.after(ciphertext, nonce, sharedSecret);

      if (!plaintext) {
        throw new EncryptionError(
          'decryption_failed',
          'Decryption returned null – message may have been tampered with',
        );
      }

      return encodeUTF8(plaintext);
    } catch (error) {
      if (error instanceof EncryptionError) {
        throw error;
      }
      throw new EncryptionError(
        'decryption_failed',
        'Failed to decrypt message',
        error as Error,
      );
    }
  }

  // ──────────────────────────────────────────────
  // Configuration
  // ──────────────────────────────────────────────

  /**
   * Update runtime encryption configuration.
   */
  public updateConfig(partial: Partial<EncryptionConfig>): void {
    this.config = { ...this.config, ...partial };
    this.log.info('Encryption config updated', { config: this.config });
  }

  /**
   * Get current encryption configuration.
   */
  public getConfig(): Readonly<EncryptionConfig> {
    return { ...this.config };
  }

  /**
   * Check whether encryption is enabled.
   */
  public isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Check whether encryption is required (reject unencrypted traffic).
   */
  public isRequired(): boolean {
    return this.config.required;
  }

  /**
   * Check whether a peer has completed key exchange and is ready for
   * encrypted communication.
   */
  public isPeerReady(peerId: string): boolean {
    return this.sharedSecrets.has(peerId);
  }

  // ──────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────

  private async generateAndStoreKeyPair(): Promise<void> {
    const raw = nacl.box.keyPair();
    this.localKeyPair = raw;

    const meta: KeyPair = {
      publicKey: encodeBase64(raw.publicKey),
      privateKey: encodeBase64(raw.secretKey),
      createdAt: new Date().toISOString(),
      version: ENCRYPTION_VERSION,
    };
    this.localKeyPairMeta = meta;

    await this.secrets.store(SECRET_KEY_STORAGE, JSON.stringify(meta));
    this.log.info('Generated and stored new key pair');
  }
}
