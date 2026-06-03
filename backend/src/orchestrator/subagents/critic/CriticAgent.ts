/**
 * Critic Agent — adversarial reviewer for specs (Scribe) and code (Proto).
 * Independent verification — fresh context, no shared state with the producer.
 *
 * Ported from AKIS v1. ADAPTATION: v1 injected a SkillRegistry to enhance the
 * system prompt inside the agent. In the MVP, skills are SELECTED at the
 * orchestrator layer (buildServices resolves a workflow's per-agent skill NAMES
 * against the loaded registry) and the resolved Skill[] is passed in here, so this
 * agent owns only the FOLDING — appending the selected skill text onto BOTH of its
 * internally-built prompts via the shared `buildSystemPrompt` helper (P3-AGENT-1B).
 * No skills (the default) ⇒ both prompts are byte-identical to today.
 */

import type {
  CriticFinding,
  CriticReviewInput,
  CriticReviewOutput,
} from './CriticTypes.js';
import {
  buildSpecReviewSystemPrompt,
  buildSpecReviewUserPrompt,
} from './prompts/spec-review.js';
import {
  buildCodeReviewSystemPrompt,
  buildCodeReviewUserPrompt,
} from './prompts/code-review.js';
import { parseAIJson } from './json-extract.js';
import { buildSystemPrompt, type Skill } from '../../../skills/registry.js';

// ─── Dependency Interface ────────────────────────

export interface CriticAIDeps {
  generateText(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ─── Result Type ─────────────────────────────────

export type CriticResult =
  | { type: 'review'; data: CriticReviewOutput }
  | { type: 'error'; error: { code: string; message: string } };

// ─── Constants ───────────────────────────────────

export const DEFAULT_APPROVAL_THRESHOLD = 75;

// ─── CriticAgent ─────────────────────────────────

export class CriticAgent {
  private ai: CriticAIDeps;
  private approvalThreshold: number;
  /** Workflow-selected skills (already resolved against the registry by the DI layer).
   *  Inert guidance text folded onto BOTH prompts; empty ⇒ byte-identical base prompts. */
  private skills: Skill[];

  constructor(
    ai: CriticAIDeps,
    approvalThreshold: number = DEFAULT_APPROVAL_THRESHOLD,
    skills: Skill[] = [],
  ) {
    this.ai = ai;
    // Clamp to the valid score range so a misconfigured value can never crash parsing.
    this.approvalThreshold = Math.max(0, Math.min(100, Math.floor(approvalThreshold)));
    this.skills = skills;
  }

  /** Exposed so the same threshold can be surfaced alongside the score. */
  getApprovalThreshold(): number {
    return this.approvalThreshold;
  }

  /** Fold the selected skills onto a freshly-built base prompt. No skills (the
   *  default) ⇒ buildSystemPrompt returns the base unchanged (byte-identical). */
  private withSkills(base: string): string {
    return buildSystemPrompt(base, this.skills);
  }

  /**
   * Review a StructuredSpec produced by Scribe.
   * Uses a fresh LLM session — no shared context with Scribe.
   */
  async reviewSpec(input: CriticReviewInput, iteration = 1): Promise<CriticResult> {
    if (input.reviewType !== 'spec_review') {
      return {
        type: 'error',
        error: { code: 'CRITIC_INVALID_INPUT', message: 'reviewSpec requires reviewType "spec_review"' },
      };
    }

    const userPrompt = buildSpecReviewUserPrompt(input.artifact, input.originalIdea, iteration);

    let responseText: string;
    try {
      responseText = await this.ai.generateText(
        this.withSkills(buildSpecReviewSystemPrompt(this.approvalThreshold)),
        userPrompt,
      );
    } catch {
      return { type: 'error', error: { code: 'CRITIC_AI_ERROR', message: 'Spec review AI call failed' } };
    }

    return this.parseReviewResponse(responseText, 'spec_review', iteration);
  }

  /**
   * Review code output produced by Proto against the approved spec.
   * Uses a fresh LLM session — no shared context with Proto.
   */
  async reviewCode(input: CriticReviewInput, iteration = 1): Promise<CriticResult> {
    if (input.reviewType !== 'code_review') {
      return {
        type: 'error',
        error: { code: 'CRITIC_INVALID_INPUT', message: 'reviewCode requires reviewType "code_review"' },
      };
    }

    if (!input.referenceSpec) {
      return {
        type: 'error',
        error: { code: 'CRITIC_MISSING_SPEC', message: 'Code review requires referenceSpec for compliance check' },
      };
    }

    const userPrompt = buildCodeReviewUserPrompt(
      input.artifact,
      input.originalIdea,
      input.referenceSpec,
      iteration,
    );

    let responseText: string;
    try {
      responseText = await this.ai.generateText(
        this.withSkills(buildCodeReviewSystemPrompt(this.approvalThreshold)),
        userPrompt,
      );
    } catch {
      return { type: 'error', error: { code: 'CRITIC_AI_ERROR', message: 'Code review AI call failed' } };
    }

    return this.parseReviewResponse(responseText, 'code_review', iteration);
  }

  // ─── Private Helpers ────────────────────────────

  private parseReviewResponse(
    responseText: string,
    reviewType: 'spec_review' | 'code_review',
    iteration: number,
  ): CriticResult {
    let parsed: Record<string, unknown>;
    try {
      parsed = parseAIJson<Record<string, unknown>>(responseText);
    } catch {
      return {
        type: 'error',
        error: { code: 'CRITIC_PARSE_ERROR', message: 'Failed to parse critic AI response as JSON' },
      };
    }

    const output = this.normalizeReviewOutput(parsed, reviewType, iteration);
    return { type: 'review', data: output };
  }

  private normalizeReviewOutput(
    raw: Record<string, unknown>,
    reviewType: 'spec_review' | 'code_review',
    iteration: number,
  ): CriticReviewOutput {
    const overallScore = typeof raw.overallScore === 'number'
      ? Math.max(0, Math.min(100, raw.overallScore))
      : 0;

    const findings: CriticFinding[] = Array.isArray(raw.findings)
      ? (raw.findings as Record<string, unknown>[]).map((f) => ({
          severity: this.normalizeSeverity(f.severity),
          category: this.normalizeCategory(f.category),
          description: typeof f.description === 'string' ? f.description : 'No description',
          suggestion: typeof f.suggestion === 'string' ? f.suggestion : 'No suggestion',
          ...(typeof f.location === 'string' ? { location: f.location } : {}),
        }))
      : [];

    const summary = typeof raw.summary === 'string' ? raw.summary : 'No summary provided';

    const SEVERITY_ORDER: Record<CriticFinding['severity'], number> = {
      info: 0,
      minor: 1,
      major: 2,
      critical: 3,
    };
    let maxSeverity: CriticFinding['severity'] = 'info';
    for (const f of findings) {
      if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[maxSeverity]) {
        maxSeverity = f.severity;
      }
    }
    const hasCriticalFinding = maxSeverity === 'critical';

    return {
      approved: overallScore >= this.approvalThreshold,
      overallScore,
      findings,
      summary,
      reviewType,
      iteration,
      hasCriticalFinding,
      maxSeverity,
    };
  }

  private normalizeSeverity(val: unknown): CriticFinding['severity'] {
    const valid = ['critical', 'major', 'minor', 'info'];
    return typeof val === 'string' && valid.includes(val)
      ? (val as CriticFinding['severity'])
      : 'info';
  }

  private normalizeCategory(val: unknown): CriticFinding['category'] {
    const valid = ['completeness', 'ambiguity', 'consistency', 'testability', 'spec_compliance', 'security'];
    return typeof val === 'string' && valid.includes(val)
      ? (val as CriticFinding['category'])
      : 'completeness';
  }
}
