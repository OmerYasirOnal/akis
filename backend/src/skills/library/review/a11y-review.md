---
name: a11y-review
description: A concrete checklist for an accessibility (a11y) review of frontend code
appliesToRole: critic
triggers: [accessibility, a11y, wcag, screen reader, accessible, aria]
status: draft
version: 0.1.0
---

Review the frontend code for accessibility with fresh eyes. Work through this checklist and report concrete findings (file + line where possible), each with severity and a fix.

- Semantics: are native elements used (button, a, nav, label) instead of div/span with click handlers?
- Keyboard: is every interactive element focusable and operable by keyboard? Visible focus styles? No keyboard traps?
- Labels: do inputs have associated labels? Do icon-only buttons have accessible names (aria-label)?
- Images & media: meaningful alt text; decorative images marked as such.
- Contrast: is text/background contrast likely to meet WCAG AA?
- ARIA: used correctly and only where native semantics are insufficient (no redundant/conflicting roles).
- Structure: logical heading order; landmarks; form errors announced.

Flag genuine barriers, not style preferences — cite the code. Blocking-an-entire-task barriers are "major" or higher.
