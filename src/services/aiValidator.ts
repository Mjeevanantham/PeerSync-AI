/**
 * PeerSync Dev Connect - AI Validator Service
 * 
 * Provides AI-powered validation, sanitization, and enhancement of messages.
 * Includes security scanning, prompt improvement, and context enrichment.
 * 
 * TODO: [ ] LLM API integration (OpenAI, Anthropic, local models)
 * TODO: [ ] Custom model fine-tuning for code-specific validation
 * TODO: [ ] Rate limiting and usage tracking
 */

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { CONFIG_KEYS, DEFAULTS, API_ENDPOINTS } from '../utils/constants';
import type { 
  Message, 
  ValidationDetails, 
  FileContext 
} from '../models/session';

/**
 * Validation result
 */
export interface ValidationResult {
  /** Whether the content is valid */
  isValid: boolean;
  /** Whether the content is secure */
  isSecure: boolean;
  /** Security issues found */
  securityIssues: string[];
  /** Sanitized content */
  sanitizedContent: string;
  /** Improved content suggestion */
  improvedContent?: string;
  /** Enriched context */
  enrichedContext?: string;
  /** Validation metadata */
  metadata: {
    processingTime: number;
    rulesApplied: string[];
  };
}

/**
 * Security scan result
 */
export interface SecurityScanResult {
  /** Whether the content passed security scan */
  passed: boolean;
  /** Security issues found */
  issues: SecurityIssue[];
  /** Risk level */
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Security issue detail
 */
export interface SecurityIssue {
  /** Issue type */
  type: SecurityIssueType;
  /** Issue description */
  description: string;
  /** Location in content */
  location?: {
    start: number;
    end: number;
  };
  /** Suggested fix */
  suggestedFix?: string;
}

/**
 * Types of security issues
 */
export type SecurityIssueType = 
  | 'secrets_exposure'
  | 'pii_exposure'
  | 'injection_risk'
  | 'malicious_code'
  | 'suspicious_pattern'
  | 'unsafe_url';

/**
 * Prompt improvement options
 */
export interface PromptImprovementOptions {
  /** Target AI model (if known) */
  targetModel?: string;
  /** Programming language context */
  language?: string;
  /** Task type */
  taskType?: 'code_review' | 'debugging' | 'generation' | 'explanation' | 'other';
  /** Maximum output length */
  maxLength?: number;
}

/**
 * Context enrichment options
 */
export interface EnrichmentOptions {
  /** Include file context */
  includeFileContext?: boolean;
  /** Include project context */
  includeProjectContext?: boolean;
  /** Include recent history */
  includeHistory?: boolean;
  /** Custom context to add */
  customContext?: string;
}

/**
 * AI Validator Service
 * 
 * Provides validation, sanitization, and enhancement for messages.
 */
export class AiValidatorService {
  private readonly context: vscode.ExtensionContext;
  private readonly log = logger.createChildLogger('AiValidator');
  private isEnabled: boolean = true;

  // Security patterns for detection
  private readonly secretPatterns: RegExp[] = [
    // API keys
    /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[\w-]{20,}['"]?/gi,
    // Tokens
    /(?:token|bearer)\s*[:=]\s*['"]?[\w-]{20,}['"]?/gi,
    // Passwords
    /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi,
    // AWS keys
    /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
    // Private keys
    /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    // Database connection strings
    /(?:mongodb|postgres|mysql|redis):\/\/[^\s]+/gi,
    // JWT tokens
    /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g,
  ];

  private readonly piiPatterns: RegExp[] = [
    // Email addresses
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    // Phone numbers
    /\b(?:\+?1[-.]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g,
    // SSN (US)
    /\b\d{3}[-]?\d{2}[-]?\d{4}\b/g,
    // Credit card numbers
    /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  ];

  private readonly injectionPatterns: RegExp[] = [
    // SQL injection
    /(?:union\s+select|drop\s+table|delete\s+from|insert\s+into)/gi,
    // Shell injection
    /(?:\||&&|;)\s*(?:rm|cat|wget|curl|bash|sh)\s/g,
    // Path traversal
    /(?:\.\.\/|\.\.\\){2,}/g,
  ];

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.loadConfiguration();
  }

  /**
   * Initialize the validator service
   */
  public async initialize(): Promise<void> {
    this.log.info('Initializing AI validator service');
    
    // Listen for configuration changes
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_KEYS.ENABLE_AI_VALIDATION)) {
        this.loadConfiguration();
      }
    });
  }

  /**
   * Load configuration
   */
  private loadConfiguration(): void {
    const config = vscode.workspace.getConfiguration();
    this.isEnabled = config.get<boolean>(
      CONFIG_KEYS.ENABLE_AI_VALIDATION, 
      DEFAULTS.ENABLE_AI_VALIDATION
    );
  }

  /**
   * Validate a message
   */
  public async validateMessage(message: Message): Promise<ValidationResult> {
    const startTime = Date.now();
    this.log.debug('Validating message', { messageId: message.id });

    if (!this.isEnabled) {
      return this.createPassThroughResult(message.content, startTime);
    }

    const rulesApplied: string[] = [];

    // Step 1: Sanitize input
    const sanitizedContent = this.sanitizeInput(message.content);
    rulesApplied.push('sanitize');

    // Step 2: Security scan
    const securityResult = this.securityScan(sanitizedContent);
    rulesApplied.push('security_scan');

    // Step 3: Improve prompt if it's an AI prompt
    let improvedContent: string | undefined;
    if (message.type === 'ai-prompt') {
      improvedContent = await this.improvePrompt(sanitizedContent);
      rulesApplied.push('prompt_improvement');
    }

    // Step 4: Enrich context if needed
    let enrichedContext: string | undefined;
    if (message.metadata?.fileContext) {
      enrichedContext = await this.enrichContext(
        sanitizedContent,
        message.metadata.fileContext
      );
      rulesApplied.push('context_enrichment');
    }

    const processingTime = Date.now() - startTime;

    return {
      isValid: securityResult.riskLevel !== 'critical',
      isSecure: securityResult.passed,
      securityIssues: securityResult.issues.map(i => i.description),
      sanitizedContent,
      improvedContent,
      enrichedContext,
      metadata: {
        processingTime,
        rulesApplied,
      },
    };
  }

  /**
   * Sanitize input content
   * 
   * Removes or escapes potentially harmful content while preserving
   * the intended meaning of the message.
   */
  public sanitizeInput(content: string): string {
    this.log.debug('Sanitizing input');
    
    let sanitized = content;

    // Remove null bytes
    sanitized = sanitized.replace(/\0/g, '');

    // Normalize Unicode
    sanitized = sanitized.normalize('NFC');

    // Remove control characters (except newlines and tabs)
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Trim excessive whitespace
    sanitized = sanitized.replace(/\s{3,}/g, '  ');

    // Enforce maximum length
    if (sanitized.length > DEFAULTS.MESSAGE_MAX_LENGTH) {
      sanitized = sanitized.substring(0, DEFAULTS.MESSAGE_MAX_LENGTH);
      this.log.warn('Message truncated due to length limit');
    }

    return sanitized.trim();
  }

  /**
   * Improve a prompt for better AI responses
   * 
   * TODO: [ ] Integrate with LLM API for intelligent prompt improvement
   */
  public async improvePrompt(
    prompt: string,
    options: PromptImprovementOptions = {}
  ): Promise<string> {
    this.log.debug('Improving prompt', { options });

    // TODO: [ ] Replace with actual LLM API call
    // For now, apply heuristic improvements

    let improved = prompt;

    // Add clarity if prompt is too short
    if (improved.length < 20) {
      improved = `Please provide more details: ${improved}`;
    }

    // Add language context if specified
    if (options.language) {
      if (!improved.toLowerCase().includes(options.language.toLowerCase())) {
        improved = `[${options.language}] ${improved}`;
      }
    }

    // Add task type context
    if (options.taskType) {
      const taskPrefixes: Record<string, string> = {
        code_review: 'Review the following code and provide feedback:',
        debugging: 'Help debug the following issue:',
        generation: 'Generate code for the following:',
        explanation: 'Explain the following:',
        other: '',
      };
      
      const prefix = taskPrefixes[options.taskType];
      if (prefix && !improved.startsWith(prefix)) {
        improved = `${prefix}\n\n${improved}`;
      }
    }

    return improved;
  }

  /**
   * Perform security scan on content
   * 
   * Checks for secrets, PII, injection risks, and other security issues.
   */
  public securityScan(content: string): SecurityScanResult {
    this.log.debug('Performing security scan');
    
    const issues: SecurityIssue[] = [];

    // Check for secrets
    this.secretPatterns.forEach(pattern => {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        issues.push({
          type: 'secrets_exposure',
          description: 'Potential secret or API key detected',
          location: match.index !== undefined ? {
            start: match.index,
            end: match.index + match[0].length,
          } : undefined,
          suggestedFix: 'Remove or redact the sensitive information',
        });
      }
    });

    // Check for PII
    this.piiPatterns.forEach(pattern => {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        issues.push({
          type: 'pii_exposure',
          description: 'Potential PII (personally identifiable information) detected',
          location: match.index !== undefined ? {
            start: match.index,
            end: match.index + match[0].length,
          } : undefined,
          suggestedFix: 'Remove or anonymize personal information',
        });
      }
    });

    // Check for injection risks
    this.injectionPatterns.forEach(pattern => {
      const matches = content.matchAll(pattern);
      for (const match of matches) {
        issues.push({
          type: 'injection_risk',
          description: 'Potential injection attack pattern detected',
          location: match.index !== undefined ? {
            start: match.index,
            end: match.index + match[0].length,
          } : undefined,
          suggestedFix: 'Review and sanitize the suspicious pattern',
        });
      }
    });

    // Determine risk level
    let riskLevel: SecurityScanResult['riskLevel'] = 'none';
    if (issues.length > 0) {
      const hasSecrets = issues.some(i => i.type === 'secrets_exposure');
      const hasInjection = issues.some(i => i.type === 'injection_risk');
      
      if (hasSecrets && hasInjection) {
        riskLevel = 'critical';
      } else if (hasSecrets || hasInjection) {
        riskLevel = 'high';
      } else if (issues.length > 3) {
        riskLevel = 'medium';
      } else {
        riskLevel = 'low';
      }
    }

    return {
      passed: riskLevel === 'none' || riskLevel === 'low',
      issues,
      riskLevel,
    };
  }

  /**
   * Enrich content with additional context
   * 
   * TODO: [ ] Integrate with LLM API for intelligent context enrichment
   */
  public async enrichContext(
    content: string,
    fileContext?: FileContext,
    options: EnrichmentOptions = {}
  ): Promise<string> {
    this.log.debug('Enriching context', { options });

    const contextParts: string[] = [];

    // Add file context
    if (fileContext && options.includeFileContext !== false) {
      contextParts.push(`File: ${fileContext.fileName}`);
      contextParts.push(`Language: ${fileContext.language}`);
      
      if (fileContext.lineRange) {
        contextParts.push(
          `Lines: ${fileContext.lineRange.start}-${fileContext.lineRange.end}`
        );
      }
    }

    // Add project context
    if (options.includeProjectContext) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        contextParts.push(`Project: ${workspaceFolder.name}`);
      }
    }

    // Add custom context
    if (options.customContext) {
      contextParts.push(options.customContext);
    }

    // Combine context with content
    if (contextParts.length > 0) {
      return `Context:\n${contextParts.join('\n')}\n\n${content}`;
    }

    return content;
  }

  /**
   * Validate content for a specific validation type
   */
  public async validateContent(
    content: string,
    validationType: 'security' | 'quality' | 'full'
  ): Promise<ValidationResult> {
    const startTime = Date.now();
    const rulesApplied: string[] = [];

    const sanitized = this.sanitizeInput(content);
    rulesApplied.push('sanitize');

    let securityResult: SecurityScanResult = {
      passed: true,
      issues: [],
      riskLevel: 'none',
    };

    if (validationType === 'security' || validationType === 'full') {
      securityResult = this.securityScan(sanitized);
      rulesApplied.push('security_scan');
    }

    let improvedContent: string | undefined;
    if (validationType === 'quality' || validationType === 'full') {
      improvedContent = await this.improvePrompt(sanitized);
      rulesApplied.push('quality_improvement');
    }

    return {
      isValid: securityResult.riskLevel !== 'critical',
      isSecure: securityResult.passed,
      securityIssues: securityResult.issues.map(i => i.description),
      sanitizedContent: sanitized,
      improvedContent,
      metadata: {
        processingTime: Date.now() - startTime,
        rulesApplied,
      },
    };
  }

  /**
   * Create a pass-through result when validation is disabled
   */
  private createPassThroughResult(
    content: string,
    startTime: number
  ): ValidationResult {
    return {
      isValid: true,
      isSecure: true,
      securityIssues: [],
      sanitizedContent: content,
      metadata: {
        processingTime: Date.now() - startTime,
        rulesApplied: ['passthrough'],
      },
    };
  }

  /**
   * Check if validation is enabled
   */
  public isValidationEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Enable or disable validation
   */
  public setValidationEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    this.log.info(`Validation ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Dispose of service resources
   */
  public dispose(): void {
    // No resources to dispose
  }
}
