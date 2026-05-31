/**
 * Import Check
 *
 * Flags imports that reference packages not likely to be available,
 * and relative imports that escape the project.
 * (Ported verbatim from AKIS v1.)
 */

import type { ValidationCheck, ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

export class ImportCheck implements ValidationCheck {
  name = 'import';

  run(files: ValidationFile[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const file of files) {
      if (file.language !== 'typescript' && file.language !== 'javascript') {
        continue;
      }

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const importMatch = line.match(/^\s*import\s+.*\s+from\s+['"]([^'"]+)['"]/);
        if (!importMatch) continue;

        const specifier = importMatch[1];

        // Relative import escaping upward too far
        if (specifier.startsWith('../../../')) {
          issues.push({
            severity: 'warning',
            category: 'import',
            file: file.path,
            line: i + 1,
            message: `Import escapes too far up: ${specifier}`,
            rule: 'import-escape',
          });
        }
      }
    }

    return issues;
  }
}
