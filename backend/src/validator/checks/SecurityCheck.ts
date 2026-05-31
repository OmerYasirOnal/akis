/**
 * Security Check
 *
 * Flags obvious security anti-patterns in generated code.
 * (Ported verbatim from AKIS v1.)
 */

import type { ValidationCheck, ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

export class SecurityCheck implements ValidationCheck {
  name = 'security';

  run(files: ValidationFile[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const file of files) {
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // eval() usage
        if (/\beval\s*\(/.test(line)) {
          issues.push({
            severity: 'error',
            category: 'security',
            file: file.path,
            line: i + 1,
            message: 'Avoid eval() — security risk',
            rule: 'no-eval',
          });
        }

        // Hardcoded secrets (very rough heuristic)
        if (/(api[_-]?key|secret|password)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(line)) {
          issues.push({
            severity: 'warning',
            category: 'security',
            file: file.path,
            line: i + 1,
            message: 'Possible hardcoded secret',
            rule: 'no-hardcoded-secret',
          });
        }
      }
    }

    return issues;
  }
}
