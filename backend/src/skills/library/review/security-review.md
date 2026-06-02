---
name: security-review
description: A concrete checklist for an adversarial security review of generated code
appliesToRole: critic
triggers: [security review, security, vulnerability, secure code, auth review, security audit]
status: draft
version: 0.1.0
---

Review the code adversarially for security issues with fresh eyes. Work through this checklist and report concrete findings (file + line where possible), each with severity and a fix.

- Input validation: is every external input (body, query, params, headers, files) validated and bounded before use?
- Injection: SQL/NoSQL/command/template injection from unsanitized input? Parameterized queries used?
- XSS / output encoding: is user data escaped where rendered?
- AuthN/AuthZ: are protected operations actually checked? Any missing ownership/role checks (IDOR)?
- Secrets: hardcoded keys/passwords/tokens? Secrets logged?
- Dangerous APIs: eval, child_process with user input, unsafe deserialization?
- Transport & data: sensitive data over plaintext, weak hashing, predictable IDs?
- Dependencies: obviously outdated or risky packages.

Security findings are at least "major"; a clear exploit path is "critical". Don't invent issues — cite the code.
