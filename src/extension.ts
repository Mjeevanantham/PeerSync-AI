/**
 * PeerSync Dev Connect - Extension Entry Point
 * 
 * Main entry point for the VS Code extension. Handles initialization,
 * service registration, and command binding.
 * 
 * This extension provides cross-IDE developer collaboration with:
 * - Peer discovery and connection
 * - Real-time chat with AI validation
 * - AI-powered message enhancement
 * - IDE AI integration for prompts and responses
 * 
 * Compatible with: VS Code, Cursor, Windsurf, and similar IDEs
 * 
 * =================================================
 * TODO ROADMAP
 * =================================================
 * 
 * [ ] OAuth integration - GitHub, Google, Microsoft auth providers
 * [ ] WebRTC / Gateway - Direct peer-to-peer connections
 * [ ] End-to-end encryption - E2EE for all messages
 * [ ] Cursor native API support - Deep integration with Cursor AI
 * [ ] File sharing - Share files between peers
 * [ ] Team rooms - Group collaboration spaces
 * [ ] Analytics - Usage metrics and insights
 * [ ] Billing - Premium features and subscription management
 * [ ] Enterprise SSO - SAML/OIDC authentication
 * [ ] Mobile companion app - iOS/Android companion for notifications
 * 
 * =================================================
 */

import * as vscode from 'vscode';

// Utils
import { logger } from './utils/logger';
import { EXTENSION_ID, COMMANDS, VIEWS } from './utils/constants';

// Services
import { AuthService } from './services/authService';
import { PeerService } from './services/peerService';
import { AiValidatorService } from './services/aiValidator';
import { MessageRouterService } from './services/messageRouter';

// Commands
import { ConnectPeerCommand } from './commands/connectPeer';
import { OpenDashboardCommand } from './commands/openDashboard';
import { SendMessageCommand } from './commands/sendMessage';

// Views
import { DashboardViewProvider } from './views/dashboardView';
import { registerOpenChatCommand } from './views/chatView';

/**
 * Extension context holder for global access
 */
let extensionContext: vscode.ExtensionContext;

/**
 * Service instances
 */
let authService: AuthService;
let peerService: PeerService;
let aiValidator: AiValidatorService;
let messageRouter: MessageRouterService;

/**
 * Extension activation
 * 
 * Called when the extension is activated. Initializes all services,
 * registers commands, and sets up the UI components.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;

  // Initialize logger first
  logger.initialize();
  logger.info('Activating PeerSync Dev Connect extension', 'Extension');

  try {
    // Initialize services
    await initializeServices(context);

    // Register commands
    registerCommands(context);

    // Register views
    registerViews(context);

    // Show activation message
    logger.info('PeerSync Dev Connect activated successfully', 'Extension');
    
    // Show welcome message on first activation
    const hasShownWelcome = context.globalState.get<boolean>('peerSync.hasShownWelcome');
    if (!hasShownWelcome) {
      showWelcomeMessage();
      await context.globalState.update('peerSync.hasShownWelcome', true);
    }

  } catch (error) {
    logger.error(
      'Failed to activate PeerSync Dev Connect',
      'Extension',
      error as Error
    );
    vscode.window.showErrorMessage(
      `PeerSync Dev Connect failed to activate: ${(error as Error).message}`
    );
  }
}

/**
 * Initialize all services
 */
async function initializeServices(context: vscode.ExtensionContext): Promise<void> {
  logger.info('Initializing services', 'Extension');

  // Create service instances
  authService = new AuthService(context);
  peerService = new PeerService(context, authService);
  aiValidator = new AiValidatorService(context);
  messageRouter = new MessageRouterService(
    context,
    authService,
    peerService,
    aiValidator
  );

  // Initialize services in order
  await authService.initialize();
  await peerService.initialize();
  await aiValidator.initialize();
  await messageRouter.initialize();

  // Register disposables
  context.subscriptions.push(
    { dispose: () => authService.dispose() },
    { dispose: () => peerService.dispose() },
    { dispose: () => aiValidator.dispose() },
    { dispose: () => messageRouter.dispose() }
  );

  logger.info('All services initialized', 'Extension');
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
  logger.info('Registering commands', 'Extension');

  // Create command handlers
  const connectPeerCommand = new ConnectPeerCommand(authService, peerService);
  const openDashboardCommand = new OpenDashboardCommand(
    getDashboardProvider(context)
  );
  const sendMessageCommand = new SendMessageCommand(
    authService,
    peerService,
    messageRouter
  );

  // Register commands
  context.subscriptions.push(
    connectPeerCommand.register(context),
    openDashboardCommand.register(context),
    sendMessageCommand.register(context),
    registerOpenChatCommand(context, authService, peerService, messageRouter)
  );

  logger.info('Commands registered', 'Extension', {
    commands: [
      COMMANDS.CONNECT,
      COMMANDS.OPEN_DASHBOARD,
      COMMANDS.OPEN_CHAT,
      COMMANDS.SEND_MESSAGE,
    ],
  });
}

/**
 * Get or create the dashboard view provider
 */
let dashboardProvider: DashboardViewProvider | null = null;

function getDashboardProvider(context: vscode.ExtensionContext): DashboardViewProvider {
  if (!dashboardProvider) {
    dashboardProvider = new DashboardViewProvider(
      context.extensionUri,
      authService,
      peerService,
      messageRouter
    );
  }
  return dashboardProvider;
}

/**
 * Register all views
 */
function registerViews(context: vscode.ExtensionContext): void {
  logger.info('Registering views', 'Extension');

  // Register dashboard view provider
  const provider = getDashboardProvider(context);
  
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DashboardViewProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      }
    )
  );

  logger.info('Views registered', 'Extension', {
    views: [VIEWS.DASHBOARD, VIEWS.CHAT],
  });
}

/**
 * Show welcome message to new users
 */
function showWelcomeMessage(): void {
  vscode.window
    .showInformationMessage(
      'Welcome to PeerSync Dev Connect! Connect with your team and collaborate in real-time.',
      'Get Started',
      'Learn More'
    )
    .then((selection) => {
      if (selection === 'Get Started') {
        vscode.commands.executeCommand(COMMANDS.OPEN_DASHBOARD);
      } else if (selection === 'Learn More') {
        vscode.env.openExternal(
          vscode.Uri.parse('https://github.com/peersync/dev-connect')
        );
      }
    });
}

/**
 * Extension deactivation
 * 
 * Called when the extension is deactivated. Cleans up resources
 * and disconnects from the peer network.
 */
export function deactivate(): void {
  logger.info('Deactivating PeerSync Dev Connect extension', 'Extension');

  // Disconnect from peer network
  if (peerService) {
    peerService.disconnect();
  }

  // Dispose logger
  logger.dispose();
}

/**
 * Export services for testing
 */
export function getServices() {
  return {
    authService,
    peerService,
    aiValidator,
    messageRouter,
  };
}
