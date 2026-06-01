/**
 * Deterministic Validator Types
 *
 * Purely deterministic code-quality checks — no LLM calls.
 * This module is the anchor between probabilistic pipeline steps.
 * (Ported verbatim from AKIS v1.)
 */

export interface ValidationFile {
  path: string;
  content: string;
  language: 'typescript' | 'javascript' | 'json' | 'html' | 'css';
}

export interface ValidationInput {
  files: ValidationFile[];
  spec?: unknown; // StructuredSpec for compliance checking
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  category: 'syntax' | 'import' | 'type' | 'security' | 'structure';
  file: string;
  line?: number;
  message: string;
  rule: string;
}

export interface ValidationResult {
  passed: boolean;
  score: number; // 0-100
  issues: ValidationIssue[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    filesChecked: number;
    checksRun: string[];
  };
}

/**
 * Interface for a single validation check.
 * Each check is a pure function: files in, issues out.
 */
export interface ValidationCheck {
  name: string;
  run(files: ValidationFile[]): ValidationIssue[];
}
