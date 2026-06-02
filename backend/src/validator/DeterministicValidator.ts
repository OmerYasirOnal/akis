/**
 * Deterministic Validator
 *
 * Runs all deterministic checks and computes a quality score.
 * No LLM calls — pure, fast, reproducible.
 * (Ported verbatim from AKIS v1.)
 *
 * Scoring model:
 *   - Start at 100
 *   - Each error: -15
 *   - Each warning: -5
 *   - Each info: -1
 *   - passed = score >= 60 AND errors === 0
 */

import type {
  ValidationInput,
  ValidationResult,
  ValidationIssue,
  ValidationCheck,
} from './ValidatorTypes.js';
import { SyntaxCheck } from './checks/SyntaxCheck.js';
import { ImportCheck } from './checks/ImportCheck.js';
import { TypeConsistencyCheck } from './checks/TypeConsistencyCheck.js';
import { SecurityCheck } from './checks/SecurityCheck.js';
import { StructureCheck } from './checks/StructureCheck.js';

export class DeterministicValidator {
  private checks: ValidationCheck[];

  constructor(checks?: ValidationCheck[]) {
    // Default: all 5 checks. Allow injection for testing.
    this.checks = checks ?? [
      new SyntaxCheck(),
      new ImportCheck(),
      new TypeConsistencyCheck(),
      new SecurityCheck(),
      new StructureCheck(),
    ];
  }

  validate(input: ValidationInput): ValidationResult {
    const allIssues: ValidationIssue[] = [];
    const checksRun: string[] = [];

    for (const check of this.checks) {
      try {
        const issues = check.run(input.files);
        allIssues.push(...issues);
        checksRun.push(check.name);
      } catch (err) {
        // A check throwing shouldn't crash the pipeline
        allIssues.push({
          severity: 'warning',
          category: 'structure',
          file: 'validator',
          line: 0,
          message: `Check ${check.name} failed: ${err instanceof Error ? err.message : 'unknown'}`,
          rule: 'check-error',
        });
      }
    }

    const errors = allIssues.filter((i) => i.severity === 'error').length;
    const warnings = allIssues.filter((i) => i.severity === 'warning').length;
    const infos = allIssues.filter((i) => i.severity === 'info').length;

    const score = Math.max(0, 100 - errors * 15 - warnings * 5 - infos * 1);
    const passed = score >= 60 && errors === 0;

    return {
      passed,
      score,
      issues: allIssues,
      summary: {
        errors,
        warnings,
        infos,
        filesChecked: input.files.length,
        checksRun,
      },
    };
  }
}
