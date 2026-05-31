/**
 * Syntax Check
 *
 * Catches basic syntax errors: unbalanced braces, brackets, parens.
 * Not a full parser — just balance + a few common mistakes.
 * (Ported verbatim from AKIS v1.)
 */

import type { ValidationCheck, ValidationFile, ValidationIssue } from '../ValidatorTypes.js';

export class SyntaxCheck implements ValidationCheck {
  name = 'syntax';

  run(files: ValidationFile[]): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    for (const file of files) {
      // Skip non-code files
      if (file.language === 'json') {
        this.checkJson(file, issues);
        continue;
      }
      if (file.language !== 'typescript' && file.language !== 'javascript') {
        continue;
      }

      this.checkBalance(file, issues);
    }

    return issues;
  }

  private checkJson(file: ValidationFile, issues: ValidationIssue[]): void {
    try {
      JSON.parse(file.content);
    } catch (err) {
      issues.push({
        severity: 'error',
        category: 'syntax',
        file: file.path,
        message: `Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
        rule: 'json-parse',
      });
    }
  }

  private checkBalance(file: ValidationFile, issues: ValidationIssue[]): void {
    const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
    const closers = new Set(Object.values(pairs));
    const stack: { char: string; line: number }[] = [];
    const lines = file.content.split('\n');

    // Strip strings/comments crudely to avoid false positives
    let inBlockComment = false;

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      let inString: string | null = null;

      for (let i = 0; i < line.length; i++) {
        const char = line[i];

        // Handle block comments
        if (inBlockComment) {
          if (char === '*' && line[i + 1] === '/') {
            inBlockComment = false;
            i++;
          }
          continue;
        }

        // Handle strings
        if (inString) {
          if (char === inString && line[i - 1] !== '\\') {
            inString = null;
          }
          continue;
        }

        // Start of string?
        if (char === '"' || char === "'" || char === '`') {
          inString = char;
          continue;
        }

        // Start of comment?
        if (char === '/' && line[i + 1] === '/') {
          break; // rest of line is comment
        }
        if (char === '/' && line[i + 1] === '*') {
          inBlockComment = true;
          i++;
          continue;
        }

        // Track brackets
        if (char in pairs) {
          stack.push({ char, line: lineNum + 1 });
        } else if (closers.has(char)) {
          const last = stack.pop();
          if (!last || pairs[last.char] !== char) {
            issues.push({
              severity: 'error',
              category: 'syntax',
              file: file.path,
              line: lineNum + 1,
              message: `Unbalanced bracket: unexpected '${char}'`,
              rule: 'bracket-balance',
            });
          }
        }
      }
    }

    // Unclosed brackets
    for (const item of stack) {
      issues.push({
        severity: 'error',
        category: 'syntax',
        file: file.path,
        line: item.line,
        message: `Unbalanced bracket: unclosed '${item.char}'`,
        rule: 'bracket-balance',
      });
    }
  }
}
