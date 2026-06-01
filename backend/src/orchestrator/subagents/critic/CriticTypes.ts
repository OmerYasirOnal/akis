/**
 * Critic Agent Types
 *
 * Adversarial reviewer for specs (from Scribe) and code (from Proto).
 * Independent verification — fresh context, no shared state with producer.
 * (Ported verbatim from AKIS v1.)
 */

export type CriticSeverity = 'critical' | 'major' | 'minor' | 'info';

export type CriticCategory =
  | 'completeness'
  | 'ambiguity'
  | 'consistency'
  | 'testability'
  | 'spec_compliance'
  | 'security';

export interface CriticFinding {
  severity: CriticSeverity;
  category: CriticCategory;
  description: string;
  suggestion: string;
  location?: string;
}

export interface CriticReviewInput {
  reviewType: 'spec_review' | 'code_review';
  artifact: unknown; // StructuredSpec or ProtoOutput
  originalIdea: string;
  referenceSpec?: unknown; // Required for code_review
}

export interface CriticReviewOutput {
  approved: boolean;
  overallScore: number;
  findings: CriticFinding[];
  summary: string;
  reviewType: 'spec_review' | 'code_review';
  iteration: number;
  hasCriticalFinding: boolean;
  maxSeverity: CriticSeverity;
}
