/**
 * PeerSync Dev Connect - Send Message Command
 * 
 * Handles sending messages to peers with optional AI validation
 * and IDE AI integration.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { COMMANDS } from '../utils/constants';
import { AuthService } from '../services/authService';
import { PeerService } from '../services/peerService';
import { MessageRouterService, type SendMessageOptions } from '../services/messageRouter';
import type { Peer, FileContext } from '../models/session';

/**
 * Send message command handler
 */
export class SendMessageCommand {
  private readonly log = logger.createChildLogger('SendMessageCommand');
  private readonly authService: AuthService;
  private readonly peerService: PeerService;
  private readonly messageRouter: MessageRouterService;

  constructor(
    authService: AuthService,
    peerService: PeerService,
    messageRouter: MessageRouterService
  ) {
    this.authService = authService;
    this.peerService = peerService;
    this.messageRouter = messageRouter;
  }

  /**
   * Register the command
   */
  public register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand(
      COMMANDS.SEND_MESSAGE,
      this.execute.bind(this)
    );
  }

  /**
   * Execute the send message command
   */
  public async execute(
    peerId?: string,
    messageContent?: string,
    options?: SendMessageOptions
  ): Promise<void> {
    this.log.info('Executing send message command', { peerId });

    try {
      // Ensure authenticated
      if (!this.authService.isAuthenticated()) {
        vscode.window.showWarningMessage(
          'Please sign in to send messages.',
          'Sign In'
        ).then(selection => {
          if (selection === 'Sign In') {
            vscode.commands.executeCommand(COMMANDS.CONNECT);
          }
        });
        return;
      }

      // Get target peer
      const targetPeerId = peerId || await this.selectPeer();
      if (!targetPeerId) {
        return;
      }

      // Get message content
      const content = messageContent || await this.getMessageContent();
      if (!content) {
        return;
      }

      // Get file context if available
      const fileContext = this.getCurrentFileContext();

      // Show options for message type
      const messageOptions = options || await this.getMessageOptions();

      // Send message
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Sending message...',
          cancellable: false,
        },
        async () => {
          const message = await this.messageRouter.sendMessage(
            targetPeerId,
            content,
            {
              ...messageOptions,
              fileContext,
            }
          );

          if (message) {
            this.log.info('Message sent', { messageId: message.id });
            
            if (messageOptions.insertToAi) {
              vscode.window.showInformationMessage(
                'Message sent and inserted to AI chat!'
              );
            } else {
              vscode.window.showInformationMessage('Message sent!');
            }
          } else {
            vscode.window.showErrorMessage('Failed to send message');
          }
        }
      );
    } catch (error) {
      this.log.error('Send message command failed', error as Error);
      vscode.window.showErrorMessage(
        `Failed to send message: ${(error as Error).message}`
      );
    }
  }

  /**
   * Select a peer to send message to
   */
  private async selectPeer(): Promise<string | undefined> {
    const connectedPeers = this.peerService.getConnectedPeers();
    
    if (connectedPeers.length === 0) {
      const result = await vscode.window.showWarningMessage(
        'No connected peers. Would you like to connect to a peer first?',
        'Connect',
        'Cancel'
      );
      
      if (result === 'Connect') {
        await vscode.commands.executeCommand(COMMANDS.CONNECT);
      }
      return undefined;
    }

    const items = connectedPeers.map(peer => ({
      label: peer.profile.displayName,
      description: peer.profile.role,
      detail: peer.profile.email,
      peerId: peer.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a peer to send message to',
    });

    return selected?.peerId;
  }

  /**
   * Get message content from user
   */
  private async getMessageContent(): Promise<string | undefined> {
    // Check if there's selected text
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty) {
      const selectedText = editor.document.getText(editor.selection);
      
      const result = await vscode.window.showQuickPick(
        [
          { label: 'Send selected text', value: 'selected' },
          { label: 'Write custom message', value: 'custom' },
          { label: 'Send selected as code', value: 'code' },
        ],
        { placeHolder: 'What would you like to send?' }
      );

      if (result?.value === 'selected') {
        return selectedText;
      } else if (result?.value === 'code') {
        const language = editor.document.languageId;
        return `\`\`\`${language}\n${selectedText}\n\`\`\``;
      }
    }

    // Get custom message
    return await vscode.window.showInputBox({
      prompt: 'Enter your message',
      placeHolder: 'Type your message here...',
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return 'Message cannot be empty';
        }
        return null;
      },
    });
  }

  /**
   * Get current file context
   */
  private getCurrentFileContext(): FileContext | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }

    const document = editor.document;
    const selection = editor.selection;

    return {
      filePath: document.uri.fsPath,
      fileName: document.fileName.split('/').pop() || document.fileName,
      language: document.languageId,
      lineRange: selection.isEmpty ? undefined : {
        start: selection.start.line + 1,
        end: selection.end.line + 1,
      },
    };
  }

  /**
   * Get message sending options from user
   */
  private async getMessageOptions(): Promise<SendMessageOptions> {
    const options = await vscode.window.showQuickPick(
      [
        { 
          label: '$(comment) Send as text', 
          value: 'text',
          description: 'Regular text message' 
        },
        { 
          label: '$(code) Send as code', 
          value: 'code',
          description: 'Format as code snippet' 
        },
        { 
          label: '$(sparkle) Send as AI prompt', 
          value: 'ai-prompt',
          description: 'Send to peer\'s AI assistant' 
        },
        { 
          label: '$(rocket) Send and insert to AI', 
          value: 'insert-ai',
          description: 'Send to peer and insert to their AI chat' 
        },
      ],
      { 
        placeHolder: 'How would you like to send this message?',
      }
    );

    if (!options) {
      return {};
    }

    return {
      type: options.value === 'insert-ai' ? 'ai-prompt' : options.value as any,
      insertToAi: options.value === 'insert-ai',
    };
  }

  /**
   * Send quick message (for programmatic use)
   */
  public async sendQuickMessage(
    peerId: string,
    content: string,
    type: 'text' | 'code' | 'ai-prompt' = 'text'
  ): Promise<boolean> {
    const message = await this.messageRouter.sendMessage(peerId, content, {
      type,
      skipValidation: false,
    });
    return message !== null;
  }
}
