/**
 * PeerSync Dev Connect - Connect Peer Command
 * 
 * Handles the peer connection workflow including authentication,
 * peer discovery, and connection establishment.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { COMMANDS } from '../utils/constants';
import { AuthService, type LoginCredentials } from '../services/authService';
import { PeerService } from '../services/peerService';
import type { Peer } from '../models/session';

/**
 * Connect peer command handler
 */
export class ConnectPeerCommand {
  private readonly log = logger.createChildLogger('ConnectPeerCommand');
  private readonly authService: AuthService;
  private readonly peerService: PeerService;

  constructor(authService: AuthService, peerService: PeerService) {
    this.authService = authService;
    this.peerService = peerService;
  }

  /**
   * Register the command
   */
  public register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand(
      COMMANDS.CONNECT,
      this.execute.bind(this)
    );
  }

  /**
   * Execute the connect peer command
   */
  public async execute(peerId?: string): Promise<void> {
    this.log.info('Executing connect peer command', { peerId });

    try {
      // Step 1: Ensure user is authenticated
      if (!this.authService.isAuthenticated()) {
        const authenticated = await this.promptLogin();
        if (!authenticated) {
          return;
        }
      }

      // Step 2: Connect to peer network if not connected
      const connectionState = this.peerService.getConnectionState();
      if (connectionState !== 'connected') {
        const connected = await this.connectToNetwork();
        if (!connected) {
          return;
        }
      }

      // Step 3: If peerId provided, connect to specific peer
      if (peerId) {
        await this.connectToSpecificPeer(peerId);
        return;
      }

      // Step 4: Otherwise, show peer selection
      await this.showPeerSelection();
    } catch (error) {
      this.log.error('Connect peer command failed', error as Error);
      vscode.window.showErrorMessage(
        `Failed to connect: ${(error as Error).message}`
      );
    }
  }

  /**
   * Prompt user to login
   */
  private async promptLogin(): Promise<boolean> {
    const result = await vscode.window.showInformationMessage(
      'You need to sign in to connect with peers.',
      'Sign In',
      'Cancel'
    );

    if (result !== 'Sign In') {
      return false;
    }

    // Show login input
    const email = await vscode.window.showInputBox({
      prompt: 'Enter your email',
      placeHolder: 'email@example.com',
      validateInput: (value) => {
        if (!value || !value.includes('@')) {
          return 'Please enter a valid email';
        }
        return null;
      },
    });

    if (!email) {
      return false;
    }

    const password = await vscode.window.showInputBox({
      prompt: 'Enter your password',
      password: true,
      validateInput: (value) => {
        if (!value || value.length < 6) {
          return 'Password must be at least 6 characters';
        }
        return null;
      },
    });

    if (!password) {
      return false;
    }

    // Attempt login
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Signing in...',
        cancellable: false,
      },
      async () => {
        const credentials: LoginCredentials = { email, password };
        const success = await this.authService.login(credentials);
        
        if (success) {
          vscode.window.showInformationMessage('Successfully signed in!');
        } else {
          vscode.window.showErrorMessage('Sign in failed. Please try again.');
        }
        
        return success;
      }
    );
  }

  /**
   * Connect to the peer network
   */
  private async connectToNetwork(): Promise<boolean> {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Connecting to PeerSync network...',
        cancellable: false,
      },
      async () => {
        const success = await this.peerService.connect();
        
        if (success) {
          vscode.window.showInformationMessage('Connected to PeerSync network!');
        } else {
          vscode.window.showErrorMessage(
            'Failed to connect to PeerSync network. Please try again.'
          );
        }
        
        return success;
      }
    );
  }

  /**
   * Connect to a specific peer
   */
  private async connectToSpecificPeer(peerId: string): Promise<void> {
    const peer = this.peerService.getPeer(peerId);
    if (!peer) {
      vscode.window.showErrorMessage('Peer not found');
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Connecting to ${peer.profile.displayName}...`,
        cancellable: false,
      },
      async () => {
        const success = await this.peerService.connectToPeer(peerId);
        
        if (success) {
          vscode.window.showInformationMessage(
            `Connected to ${peer.profile.displayName}!`
          );
          // Open chat with the peer
          vscode.commands.executeCommand('peerSync.openChat', peerId);
        } else {
          vscode.window.showErrorMessage(
            `Failed to connect to ${peer.profile.displayName}`
          );
        }
      }
    );
  }

  /**
   * Show peer selection quick pick
   */
  private async showPeerSelection(): Promise<void> {
    // Discover peers
    const peers = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Discovering peers...',
        cancellable: false,
      },
      async () => {
        return await this.peerService.discoverPeers({ onlineOnly: true });
      }
    );

    if (peers.length === 0) {
      vscode.window.showInformationMessage('No peers available. Invite your team!');
      return;
    }

    // Create quick pick items
    const items = peers.map(peer => this.createPeerQuickPickItem(peer));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a peer to connect',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (selected) {
      await this.connectToSpecificPeer(selected.peerId);
    }
  }

  /**
   * Create a quick pick item for a peer
   */
  private createPeerQuickPickItem(peer: Peer): vscode.QuickPickItem & { peerId: string } {
    const statusIcon = this.getStatusIcon(peer.profile.status);
    const roleLabel = this.getRoleLabel(peer.profile.role);
    
    return {
      label: `${statusIcon} ${peer.profile.displayName}`,
      description: roleLabel,
      detail: peer.profile.email,
      peerId: peer.id,
    };
  }

  /**
   * Get status icon for user status
   */
  private getStatusIcon(status: string): string {
    const icons: Record<string, string> = {
      online: '🟢',
      away: '🟡',
      busy: '🔴',
      offline: '⚫',
    };
    return icons[status] || '⚫';
  }

  /**
   * Get display label for role
   */
  private getRoleLabel(role: string): string {
    const labels: Record<string, string> = {
      frontend: 'Frontend Developer',
      backend: 'Backend Developer',
      fullstack: 'Full Stack Developer',
      devops: 'DevOps Engineer',
      other: 'Developer',
    };
    return labels[role] || 'Developer';
  }
}
