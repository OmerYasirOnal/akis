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
  /** 'text' = a non-code file (.md/.txt/…) that must NOT be syntax-balance-checked as code (the
   *  SyntaxCheck skips anything that isn't json/typescript/javascript). */
  language: 'typescript' | 'javascript' | 'json' | 'html' | 'css' | 'text';
}

/** Map a file PATH to its validation language by extension, so a generated README (.md), JSON, CSS,
 *  etc. are not all syntax-checked as TypeScript (which false-flagged balance on non-code files).
 *  Unknown / non-code extensions → 'text' (skipped by the syntax check). (Audit #46.) */
export function languageFor(path: string): ValidationFile['language'] {
  const p = path.toLowerCase();
  if (p.endsWith('.ts') || p.endsWith('.tsx')) return 'typescript';
  if (p.endsWith('.js') || p.endsWith('.jsx') || p.endsWith('.mjs') || p.endsWith('.cjs')) return 'javascript';
  if (p.endsWith('.json')) return 'json';
  if (p.endsWith('.html') || p.endsWith('.htm')) return 'html';
  if (p.endsWith('.css')) return 'css';
  return 'text';
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
