/**
 * Structure Check
 *
 * Validates project structure conventions.
 * (Ported verbatim from AKIS v1.)
 */

import type { ValidationCheck, ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

export class StructureCheck implements ValidationCheck {
  name = 'structure';

  run(files: ValidationFile[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (files.length === 0) {
      issues.push({
        severity: 'warning',
        category: 'structure',
        file: '(project)',
        message: 'No files generated',
        rule: 'empty-project',
      });
    }

    return issues;
  }
}
