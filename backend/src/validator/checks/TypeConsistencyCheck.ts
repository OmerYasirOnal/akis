/**
 * Type Consistency Check
 *
 * Lightweight heuristics for obvious type misuse.
 * Not a type checker — just common red flags.
 * (Ported verbatim from AKIS v1.)
 */

import type { ValidationCheck, ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

export class TypeConsistencyCheck implements ValidationCheck {
  name = 'type';

  run(files: ValidationFile[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const file of files) {
      if (file.language !== 'typescript') {
        continue;
      }

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        // Flag 'any' usage (info-level)
        if (/:\s*any\b/.test(line) && !line.includes('// eslint')) {
          issues.push({
            severity: 'info',
            category: 'type',
            file: file.path,
            line: i + 1,
            message: `Avoid 'any' type`,
            rule: 'no-any',
          });
        }
      }
    }

    return issues;
  }
}
