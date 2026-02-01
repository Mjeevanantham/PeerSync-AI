/**
 * PeerSync Dev Connect - Connect Peer Command
 *
 * Handles the peer connection workflow including authentication,
 * peer discovery, and connection establishment.
 * Supports: GitHub, Google, LinkedIn OAuth + Email/Password + Email OTP
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { COMMANDS } from '../utils/constants';
import { AuthService } from '../services/authService';
import { PeerService } from '../services/peerService';
import type { Peer } from '../models/session';
import type { OAuthProvider } from '../services/supabaseClient';

type SignInMethod =
  | { type: 'oauth'; provider: OAuthProvider }
  | { type: 'email_password' }
  | { type: 'email_otp' };

interface SignInOption extends vscode.QuickPickItem {
  method: SignInMethod;
}

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
      if (!this.authService.isAuthenticated()) {
        const authenticated = await this.promptLogin();
        if (!authenticated) return;
      }

      const connectionState = this.peerService.getConnectionState();
      if (connectionState !== 'connected') {
        const connected = await this.connectToNetwork();
        if (!connected) return;
      }

      if (peerId) {
        await this.connectToSpecificPeer(peerId);
        return;
      }

      await this.showPeerSelection();
    } catch (error) {
      this.log.error('Connect peer command failed', error as Error);
      vscode.window.showErrorMessage(
        `Failed to connect: ${(error as Error).message}`
      );
    }
  }

  /**
   * Present all sign-in options and route to appropriate flow
   */
  private async promptLogin(): Promise<boolean> {
    const options: SignInOption[] = [
      {
        label: '$(github) Sign in with GitHub',
        description: 'Recommended for developers',
        method: { type: 'oauth', provider: 'github' },
      },
      {
        label: '$(globe) Sign in with Google',
        description: 'Use your Google account',
        method: { type: 'oauth', provider: 'google' },
      },
      {
        label: '$(link) Sign in with LinkedIn',
        description: 'Use your LinkedIn account',
        method: { type: 'oauth', provider: 'linkedin' },
      },
      {
        label: '$(mail) Sign in with Email + Password',
        description: 'Use email and password',
        method: { type: 'email_password' },
      },
      {
        label: '$(key) Sign in with Email OTP',
        description: 'Magic link or one-time code',
        method: { type: 'email_otp' },
      },
    ];

    const selected = await vscode.window.showQuickPick(options, {
      title: 'Sign in to PeerSync',
      placeHolder: 'Choose a sign-in method',
      ignoreFocusOut: true,
    });

    if (!selected) return false;

    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Signing in...',
        cancellable: false,
      },
      async (progress) => {
        try {
          let success = false;

          if (selected.method.type === 'oauth') {
            progress.report({ message: 'Opening browser for authentication...' });
            success = await this.authService.loginWithOAuth(selected.method.provider);
          } else if (selected.method.type === 'email_password') {
            success = await this.promptEmailPassword();
          } else if (selected.method.type === 'email_otp') {
            success = await this.promptEmailOtp();
          }

          if (success) {
            const profile = this.authService.getProfile();
            vscode.window.showInformationMessage(
              `Welcome, ${profile?.displayName || 'User'}! You're now signed in.`
            );
          } else if (success === false && selected.method.type !== 'email_otp') {
            vscode.window.showErrorMessage(
              'Sign in was cancelled or failed. Please try again.'
            );
          }

          return success;
        } catch (error) {
          this.log.error('Login failed', error as Error);
          vscode.window.showErrorMessage(
            `Sign in failed: ${(error as Error).message}`
          );
          return false;
        }
      }
    );
  }

  /**
   * Email + Password flow
   */
  private async promptEmailPassword(): Promise<boolean> {
    const email = await vscode.window.showInputBox({
      prompt: 'Enter your email',
      placeHolder: 'email@example.com',
      validateInput: (v) => {
        if (!v || !v.includes('@')) return 'Please enter a valid email';
        return null;
      },
    });

    if (!email) return false;

    const password = await vscode.window.showInputBox({
      prompt: 'Enter your password',
      password: true,
      validateInput: (v) => {
        if (!v || v.length < 6) return 'Password must be at least 6 characters';
        return null;
      },
    });

    if (!password) return false;

    return await this.authService.loginWithEmailPassword(email, password);
  }

  /**
   * Email OTP flow - Step 1: Request OTP, Step 2: Verify
   */
  private async promptEmailOtp(): Promise<boolean> {
    const email = await vscode.window.showInputBox({
      prompt: 'Enter your email for a one-time code',
      placeHolder: 'email@example.com',
      validateInput: (v) => {
        if (!v || !v.includes('@')) return 'Please enter a valid email';
        return null;
      },
    });

    if (!email) return false;

    const result = await this.authService.requestEmailOtp(email);
    if (!result.success) {
      vscode.window.showErrorMessage(result.error || 'Failed to send OTP');
      return false;
    }

    vscode.window.showInformationMessage(
      'Check your email for the magic link or one-time code.'
    );

    // If user got a magic link, they click it and auth completes via URI handler.
    // If user got a 6-digit code, they enter it here.
    const token = await vscode.window.showInputBox({
      prompt: 'Enter the 6-digit code from your email (or click the magic link in your email)',
      placeHolder: '123456',
      validateInput: (v) => {
        if (!v || v.length < 6) return 'Please enter the 6-digit code';
        return null;
      },
    });

    if (!token) {
      // User may have clicked magic link instead - check if now authenticated
      return this.authService.isAuthenticated();
    }

    return await this.authService.verifyEmailOtp(email, token);
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
      async (progress) => {
        progress.report({ message: 'Authenticating with server...' });

        const success = await this.peerService.connect();

        if (success) {
          vscode.window.showInformationMessage('Connected to PeerSync network!');
        } else {
          const session = this.authService.getSession();
          if (!session.isAuthenticated) {
            vscode.window.showErrorMessage(
              'Authentication failed. Please sign in again.'
            );
            await this.authService.logout();
          } else {
            vscode.window.showErrorMessage(
              'Failed to connect to PeerSync network. Please check your connection and try again.'
            );
          }
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
    const peers = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Discovering peers...',
        cancellable: false,
      },
      async () => this.peerService.discoverPeers({ onlineOnly: true })
    );

    if (peers.length === 0) {
      vscode.window.showInformationMessage('No peers available. Invite your team!');
      return;
    }

    const items = peers.map((peer) => this.createPeerQuickPickItem(peer));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a peer to connect',
      matchOnDescription: true,
      matchOnDetail: true,
    });

    if (selected) await this.connectToSpecificPeer(selected.peerId);
  }

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

  private getStatusIcon(status: string): string {
    const icons: Record<string, string> = {
      online: '$(circle-filled)',
      away: '$(circle-outline)',
      busy: '$(circle-slash)',
      offline: '$(circle-outline)',
    };
    return icons[status] || '$(circle-outline)';
  }

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
