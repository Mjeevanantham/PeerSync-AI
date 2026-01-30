/**
 * PeerSync Dev Connect - Logger
 * 
 * Centralized logging service with configurable log levels,
 * output channel integration, and structured logging support.
 */

import * as vscode from 'vscode';
import { LOG_LEVELS, CONFIG_KEYS, EXTENSION_DISPLAY_NAME, type LogLevel } from './constants';

/**
 * Log entry structure for structured logging
 */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: string;
  data?: Record<string, unknown>;
  error?: Error;
}

/**
 * Logger configuration options
 */
interface LoggerConfig {
  level: string;
  showTimestamp: boolean;
  showContext: boolean;
}

/**
 * Logger class providing centralized logging functionality
 */
class Logger {
  private outputChannel: vscode.OutputChannel | null = null;
  private config: LoggerConfig = {
    level: 'info',
    showTimestamp: true,
    showContext: true,
  };
  private isInitialized = false;

  /**
   * Initialize the logger with VS Code output channel
   */
  public initialize(): void {
    if (this.isInitialized) {
      return;
    }

    this.outputChannel = vscode.window.createOutputChannel(EXTENSION_DISPLAY_NAME);
    this.loadConfiguration();
    this.isInitialized = true;

    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_KEYS.LOG_LEVEL)) {
        this.loadConfiguration();
      }
    });

    this.info('Logger initialized', 'Logger');
  }

  /**
   * Load logger configuration from VS Code settings
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration();
    const logLevel = config.get<string>(CONFIG_KEYS.LOG_LEVEL, 'info');
    
    if (this.isValidLogLevel(logLevel)) {
      this.config.level = logLevel;
    }
  }

  /**
   * Type guard to validate log level
   */
  private isValidLogLevel(level: string): level is LogLevel {
    return level in LOG_LEVELS;
  }

  /**
   * Check if a log level should be logged based on current config
   */
  private shouldLog(level: string): boolean {
    return LOG_LEVELS[level.toUpperCase() as keyof typeof LOG_LEVELS] >= 
           LOG_LEVELS[this.config.level.toUpperCase() as keyof typeof LOG_LEVELS];
  }

  /**
   * Format a log entry for output
   */
  private formatEntry(entry: LogEntry): string {
    const parts: string[] = [];

    if (this.config.showTimestamp) {
      parts.push(`[${entry.timestamp}]`);
    }

    parts.push(`[${entry.level.toUpperCase()}]`);

    if (this.config.showContext && entry.context) {
      parts.push(`[${entry.context}]`);
    }

    parts.push(entry.message);

    if (entry.data) {
      parts.push(`\n  Data: ${JSON.stringify(entry.data, null, 2)}`);
    }

    if (entry.error) {
      parts.push(`\n  Error: ${entry.error.message}`);
      if (entry.error.stack) {
        parts.push(`\n  Stack: ${entry.error.stack}`);
      }
    }

    return parts.join(' ');
  }

  /**
   * Write a log entry to the output channel
   */
  private write(entry: LogEntry): void {
    if (!this.shouldLog(entry.level)) {
      return;
    }

    const formattedMessage = this.formatEntry(entry);

    if (this.outputChannel) {
      this.outputChannel.appendLine(formattedMessage);
    }

    // Also log to console for debugging
    const level = entry.level.toLowerCase();
    const consoleMethod = level === 'error' ? 'error' 
      : level === 'warn' ? 'warn' 
      : level === 'debug' ? 'debug' 
      : 'log';
    
    console[consoleMethod](`[${EXTENSION_DISPLAY_NAME}]`, formattedMessage);
  }

  /**
   * Create a log entry with common fields
   */
  private createEntry(
    level: LogLevel,
    message: string,
    context?: string,
    data?: Record<string, unknown>,
    error?: Error
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
      data,
      error,
    };
  }

  /**
   * Log a debug message
   */
  public debug(message: string, context?: string, data?: Record<string, unknown>): void {
    this.write(this.createEntry('DEBUG' as LogLevel, message, context, data));
  }

  /**
   * Log an info message
   */
  public info(message: string, context?: string, data?: Record<string, unknown>): void {
    this.write(this.createEntry('INFO' as LogLevel, message, context, data));
  }

  /**
   * Log a warning message
   */
  public warn(message: string, context?: string, data?: Record<string, unknown>): void {
    this.write(this.createEntry('WARN' as LogLevel, message, context, data));
  }

  /**
   * Log an error message
   */
  public error(
    message: string,
    context?: string,
    error?: Error,
    data?: Record<string, unknown>
  ): void {
    this.write(this.createEntry('ERROR' as LogLevel, message, context, data, error));
  }

  /**
   * Show the output channel in the editor
   */
  public show(): void {
    this.outputChannel?.show();
  }

  /**
   * Clear the output channel
   */
  public clear(): void {
    this.outputChannel?.clear();
  }

  /**
   * Dispose of the logger resources
   */
  public dispose(): void {
    this.outputChannel?.dispose();
    this.outputChannel = null;
    this.isInitialized = false;
  }

  /**
   * Create a child logger with a fixed context
   */
  public createChildLogger(context: string): ChildLogger {
    return new ChildLogger(this, context);
  }
}

/**
 * Child logger with a fixed context for component-specific logging
 */
class ChildLogger {
  constructor(
    private readonly parent: Logger,
    private readonly context: string
  ) {}

  public debug(message: string, data?: Record<string, unknown>): void {
    this.parent.debug(message, this.context, data);
  }

  public info(message: string, data?: Record<string, unknown>): void {
    this.parent.info(message, this.context, data);
  }

  public warn(message: string, data?: Record<string, unknown>): void {
    this.parent.warn(message, this.context, data);
  }

  public error(message: string, error?: Error, data?: Record<string, unknown>): void {
    this.parent.error(message, this.context, error, data);
  }
}

// Singleton instance
export const logger = new Logger();

// Export types
export type { LogEntry, LoggerConfig, ChildLogger };
