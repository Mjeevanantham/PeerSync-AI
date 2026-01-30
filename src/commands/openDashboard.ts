/**
 * PeerSync Dev Connect - Open Dashboard Command
 * 
 * Opens the main dashboard WebView showing user profile,
 * active peers, and quick actions.
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { COMMANDS } from '../utils/constants';
import { DashboardViewProvider } from '../views/dashboardView';

/**
 * Open dashboard command handler
 */
export class OpenDashboardCommand {
  private readonly log = logger.createChildLogger('OpenDashboardCommand');
  private readonly dashboardProvider: DashboardViewProvider;

  constructor(dashboardProvider: DashboardViewProvider) {
    this.dashboardProvider = dashboardProvider;
  }

  /**
   * Register the command
   */
  public register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.commands.registerCommand(
      COMMANDS.OPEN_DASHBOARD,
      this.execute.bind(this)
    );
  }

  /**
   * Execute the open dashboard command
   */
  public async execute(): Promise<void> {
    this.log.info('Executing open dashboard command');

    try {
      // Focus the sidebar view
      await vscode.commands.executeCommand(
        'workbench.view.extension.peersync-sidebar'
      );
      
      // Refresh the dashboard
      this.dashboardProvider.refresh();
    } catch (error) {
      this.log.error('Open dashboard command failed', error as Error);
      vscode.window.showErrorMessage(
        `Failed to open dashboard: ${(error as Error).message}`
      );
    }
  }
}
