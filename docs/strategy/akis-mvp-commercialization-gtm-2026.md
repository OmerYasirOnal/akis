# AKIS MVP Commercialization & GTM Strategy

**Date:** 2026-06-02  
**Repository:** `akis-platform-mvp`  
**Purpose:** Turn AKIS from an MVP into a sellable first product with a focused ICP, pricing, validation plan, and launch sequence.  
**Core decision:** AKIS should ship the MVP as a **verified AI delivery layer**, not as a generic AI coding agent or broad agent orchestration platform.

---

## 1. Founder-level decision

AKIS should not try to beat Cursor, Lovable, Bolt, v0, Replit, Devin, or GitHub Copilot at pure code-generation speed.

The MVP should win on a narrower and more defensible promise:

> **AI can build, but AKIS proves before anything ships.**

For the MVP, this means the product must make one workflow feel inevitable:

```text
idea → spec → human approval → AI build → real test/check → separate review → human push approval → GitHub
```

The first commercial product should be:

> **AKIS Agency Beta: a verified delivery workspace for AI-built client projects.**

This is the clearest path because agencies/freelancers already sell software outcomes to non-technical clients and need proof, trust, and professional handoff. Direct SMBs are important later, but they are too support-heavy for the first paid wedge.

---

## 2. The one-page GTM answer

### Sell to

**AI/no-code agencies, freelance software builders, automation consultants, and small MVP studios.**

### Sell this promise

> Deliver AI-built client projects with approved specs, real test evidence, critical review, and human-approved GitHub handoff.

### Charge

- **Global Agency Beta:** $99/month.
- **Turkey Agency Beta:** ₺2,999–₺4,999/month.
- **Design partner price:** $49/month or ₺1,499–₺1,999/month for the first 3 months.
- Require BYO API key initially to reduce compute risk.

### MVP must include

1. Project/workspace creation.
2. Spec generation from plain-language idea.
3. Human spec approval state.
4. AI build step.
5. Real test/check evidence, even if initially simple.
6. Separate verifier/critic step.
7. Human push approval.
8. GitHub delivery or GitHub-ready patch/export.
9. Shareable trust report.

### Launch channel

1. Build-in-public videos.
2. Direct outreach to AI/no-code agencies and freelancers.
3. Two concierge pilot projects.
4. Public beta after there are proof screenshots and one case study.

### Do not build yet

- Marketplace.
- Complex studio marketplace flows.
- Heavy enterprise SSO/SOC2 motion.
- Broad SMB template catalog.
- Too many third-party integrations.

---

## 3. Why this MVP positioning is sharper than “agent orchestration”

“Agent orchestration” is technically true but commercially weak for the first buyer. Buyers do not wake up wanting orchestration. They want fewer failed deliveries, less client doubt, and safer AI-built code.

AKIS has four structural gates that can become a strong commercial wedge:

1. **Spec approval gate:** no code before scope is approved.
2. **Producer ≠ verifier:** the same AI cannot grade its own work.
3. **Verified requires evidence:** a task is not verified unless a real test/check ran.
4. **Human push gate:** GitHub changes require human approval and token/access control.

The MVP should make these gates visible. If users cannot see the gates, AKIS will look like a slower AI builder. If they can see the gates, AKIS becomes a trust product.

---

## 4. Category framing

AKIS touches four markets:

| Category | AKIS fit | MVP implication |
|---|---:|---|
| AI coding agents / AI code tools | High | Use competitor pricing as anchor, but do not fight on generation. |
| AI app builders / no-code AI | High | This is the language agencies and non-technical founders understand. |
| Agentic dev platforms | Medium-high | Useful for investor/technical positioning, not first homepage headline. |
| AI governance / verification | High differentiation | Use for trust, audit, and future self-host/team pricing. |

### Market evidence snapshot

- Mordor Intelligence estimates the AI code tools market at **$7.37B in 2025**, **$9.35B in 2026**, and **$29.96B by 2031**.
- Fortune Business Insights estimates the no-code AI platform market at **$6.56B in 2025**, **$8.6B in 2026**, and **$75.14B by 2034**.
- Grand View Research estimates the AI governance market at **$308.3M in 2025**, **$417.8M in 2026**, and **$3.59B by 2033**.
- EU AI Act directionally increases demand for documentation, oversight, logging, robustness, and traceability.

**Interpretation:** the markets are large enough, but the MVP must enter through a narrow wedge: verified delivery for AI-built software.

---

## 5. Competitive map for MVP decisions

| Competitor | Core position | Approx. self-serve price anchor | What they do well | AKIS MVP gap to own |
|---|---|---:|---|---|
| Cursor | AI-native coding IDE | $20 individual, $40 team/user | Developer workflow and code editing | Not client-delivery-first; gates are not the product narrative. |
| Devin | Autonomous software engineer | $20 Pro, $200 Max, team/enterprise | Agent delegation and autonomy | AKIS should be the controlled alternative: less blind autonomy, more proof. |
| Lovable | Prompt-to-app builder | $25 Pro, $50 Business | Fast app creation for non-coders | Weak on explicit test evidence and client approval ledger. |
| v0 | Vercel AI app/UI builder | $30 Team, $100 Business/user | UI and Vercel deployment | Not focused on proof before GitHub delivery. |
| Bolt.new | Browser full-stack builder | $25 Pro, $30 Teams/member | Fast MVP creation and launch | Speed-first; AKIS should be verified-handoff-first. |
| Replit Agent | Cloud IDE + agent + hosting | $25 Core, $100 Pro | Agent + cloud runtime + deployment | Probabilistic agent behavior creates opening for evidence gates. |
| GitHub Copilot | GitHub-native AI coding | $10–$39 individual, $19–$39 org/user | Distribution and enterprise trust | Biggest platform risk; AKIS should integrate with GitHub, not compete against it. |
| Factory | Enterprise AI development platform | $100–$200 advanced plans | Enterprise agent workflow | Too enterprise for first wedge; AKIS can win smaller agencies first. |
| Windsurf | AI coding IDE | $20 Pro, higher tiers | Developer IDE and Cascade | IDE-first; AKIS should avoid IDE war. |
| Qodo | AI code review/testing | ~$30–$38 team/user | Closest quality/review competitor | Strong on code quality, weaker on agency/client spec approval + delivery report. |
| Kuika / RIVER | Turkish low-code/no-code | Public pricing less clear | Local business app tooling | Not AI verified GitHub delivery. |

### Competitive conclusion

Most tools sell this:

> “Build faster.”

AKIS should sell this:

> “Build fast, but only ship what passed.”

That sentence should guide the MVP UI, landing page, demo script, onboarding, pricing, and PR description.

---

## 6. ICP ranking for the MVP

Scoring: 1 weak, 5 strong.

| Segment | Pain | Reachability | Payment power | Sales speed | MVP fit | Total | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| AI/no-code agencies & freelancers | 5 | 5 | 4 | 4 | 5 | **23** | Primary ICP |
| Indie hackers / micro-SaaS founders | 4 | 4 | 3 | 4 | 4 | **19** | Secondary PLG |
| QA/platform/security teams | 5 | 3 | 4 | 2 | 4 | **18** | Later higher-ticket path |
| Regulated teams | 5 | 2 | 5 | 1 | 3 | **16** | Not MVP-first |
| Direct SMB / “bakkal” | 3 | 2 | 2 | 2 | 3 | **12** | Channel-through-agency first |

### Primary ICP details

**Buyer:** owner/founder of a small AI/no-code agency, freelancer, or automation consultant.  
**Current behavior:** uses Lovable, Bolt, Cursor, Replit, v0, Webflow, Bubble, or custom scripts to ship client work.  
**Pain:** client asks whether the AI-built thing is actually correct; revisions are unclear; delivery looks informal; GitHub handoff is messy.  
**AKIS value:** professional trust layer and delivery proof.

### First 10 customer sources

1. LinkedIn search: “AI automation agency,” “MVP studio,” “no-code agency,” “Lovable developer,” “Bolt developer.”
2. Bionluk and Upwork profiles selling MVP/app/automation work.
3. Turkish startup and software communities.
4. X build-in-public accounts building with AI app builders.
5. Direct DM to founders posting client projects built with AI.

---

## 7. MVP packaging

### Package 1: Free Proof

**Price:** $0 / ₺0  
**Purpose:** demonstrate the gate workflow without subsidizing compute.

Included:

- 1 project.
- BYO-key only.
- Limited verified runs.
- Basic trust report.
- GitHub export or patch preview.
- No client branding.

### Package 2: Solo Builder

**Price:** $19–$29/month globally, ₺499–₺999/month in Turkey.

Included:

- 3 private projects.
- BYO-key.
- Spec approval.
- Real test/check evidence.
- GitHub push approval.
- Basic trust report.

### Package 3: Agency Beta

**Price:** $99/month globally, ₺2,999–₺4,999/month in Turkey.

Included:

- 5 client projects.
- Client approval links.
- Branded trust reports.
- GitHub handoff.
- Separate verifier/critic step.
- Founder support.
- Design-partner onboarding.

This should be the first paid offer.

### Package 4: Team Trust later

**Price:** $49–$79/user/month or $499+/month workspace.

Included later:

- RBAC.
- Audit logs.
- Required verifier policy.
- GitHub org policy.
- CI/Jira/Confluence integration.
- Self-host option.

Do not build this first unless QA/platform buyers show stronger willingness-to-pay during validation.

---

## 8. MVP feature priority

### Must ship for commercial MVP

| Priority | Feature | Why it matters |
|---:|---|---|
| P0 | Spec approval state | This is the first human-in-the-loop proof. |
| P0 | Visible run timeline | User must see idea → spec → code → test → review → push. |
| P0 | Real check/test evidence | Without this, “verified” becomes marketing only. |
| P0 | Separate verifier/critic identity | This is the strongest trust differentiator. |
| P0 | Human push approval | Makes the GitHub delivery story concrete. |
| P0 | Trust report export/share | Agencies need a client-facing artifact. |
| P1 | BYO-key provider setup | Reduces cost and improves trust/control. |
| P1 | Client approval link | Strong agency feature; can be simple at first. |
| P1 | Pricing/billing gate | Needed to validate WTP. |
| P2 | Analytics dashboard | Useful, but trust report first. |
| P2 | Marketplace | Too early. |
| P2 | Full studio | Nice, but avoid scope creep. |

### Minimum trust report contents

A good first trust report can be Markdown/HTML/PDF later. It should include:

1. Project name.
2. Approved spec summary.
3. Human approver and timestamp.
4. Producer agent/provider/model.
5. Verifier agent/provider/model.
6. Test/check command and result.
7. Critical review summary.
8. GitHub target repo/branch or export artifact.
9. Human push approval timestamp.
10. Clear disclaimer: verified against listed checks, not guaranteed bug-free forever.

---

## 9. Landing page and messaging

### Homepage headline options

Best:

> **AI-built software, verified before GitHub.**

Alternative:

> **Vibe coding without blind shipping.**

Agency-specific:

> **Müşteriye vibe değil, kanıt teslim et.**

Developer-specific:

> **No green test, no push.**

### Subheadline

> AKIS turns an idea into an approved spec, generated code, executed checks, separate review, and human-approved GitHub delivery — so AI output becomes a traceable software deliverable.

### Three message pillars

1. **Approval before build**  
   No implementation starts until the spec is accepted.

2. **Evidence before verified**  
   AKIS does not mark work as verified unless a real check/test ran and passed.

3. **Human approval before GitHub**  
   Repository changes require explicit human confirmation and access/token validation.

### Demo script

The most persuasive demo should show failure, not just success:

1. User enters a client idea.
2. AKIS writes a spec.
3. User approves spec.
4. AI builds.
5. Test fails.
6. AKIS refuses to mark it verified.
7. Agent fixes the issue.
8. Separate verifier passes it.
9. User approves push.
10. Trust report is generated.

The emotional hook is the moment AKIS says:

> “AI says it is done, but the check failed. Push blocked.”

---

## 10. GTM plan for the next 90 days

### Days 1–15: tighten MVP and proof story

Deliverables:

- One clean landing page with the verified-before-GitHub message.
- One recorded demo of the failure-blocking workflow.
- One sample trust report.
- Pricing page or fake-door pricing section.
- 50-person target list of agencies/freelancers.

Success metrics:

- 20 qualified waitlist signups.
- 5 agency/freelancer calls booked.
- 2 design partners agree to test.

### Days 16–30: concierge pilots

Deliverables:

- Run 2 real or realistic projects through AKIS.
- Manually help where product is incomplete.
- Produce trust reports.
- Ask for payment or written commitment.

Success metrics:

- 2 pilot projects complete.
- 1 paid design partner or 2 written payment commitments.
- At least 70% of pilot users say they would show the trust report to a client.

### Days 31–60: paid beta

Deliverables:

- Billing enabled or manual invoice/payment process.
- Agency Beta package live.
- Client approval link MVP.
- GitHub handoff/push approval visible in UI.

Success metrics:

- 3 paying customers.
- $150–$300 MRR minimum signal, or local equivalent.
- 5 projects created by non-founder users.
- 3 trust reports generated and shared.

### Days 61–90: public launch

Deliverables:

- Product Hunt / Hacker News / X / LinkedIn launch.
- Case study from an agency/freelancer.
- GitHub-centered demo.
- Clear roadmap and pricing.

Success metrics:

- 100 active trials or 500 waitlist signups.
- 5 paying customers or strong LOIs.
- 2 repeat users creating a second project.
- Clear decision on primary ICP.

---

## 11. Validation experiments

| Experiment | What to test | Setup | Success threshold | Decision |
|---|---|---|---:|---|
| Landing headline test | Does verified delivery beat generic AI builder? | A/B between “AI app builder” and “verified before GitHub.” | Verified version converts 2x or ≥8% | Use verified positioning. |
| Pricing fake-door | Does anyone click paid plans? | $29 Solo, $99 Agency, $499 Self-host. | ≥3% pricing click | Build billing. |
| Agency outbound | Is the buyer reachable? | 50 targeted DMs. | 10 replies, 5 calls, 2 pilots | Continue agency-first. |
| Trust report test | Is report valuable? | Show sample report to agencies. | 70% say they would send it to clients | Make report P0. |
| Failure demo | Does “AI caught lying” resonate? | Short video. | 1,000 views or 30 signups | Use demo as main GTM asset. |
| BYO-key onboarding | Is setup too hard? | Watch 5 users set provider key. | Dev/agency <15 min | Keep BYO first. |
| Turkey local price | Can Turkish agencies pay? | ₺2,999–₺4,999 offer. | 1–2 paid pilots | Keep local plan. |

---

## 12. Closed-module activation order

| Module | Decision | Reason |
|---|---|---|
| Billing | Open first | WTP must be tested now. Manual billing is acceptable if faster. |
| Analytics / Trust Report | Open second | This is the differentiator and client-facing value. |
| Studio | Only after core flow | Useful, but can become scope creep. |
| Jira/Confluence/CI | Wait for QA design partner | Do not build enterprise features without pull. |
| Marketplace | Keep closed | Marketplace is not useful until repeated workflows and supply exist. |

### Strong recommendation

The first premium feature should be:

> **Branded trust report for client delivery.**

Not more models. Not more autonomy. Not a marketplace.

---

## 13. Turkey-specific GTM

### Do in Turkey

- Sell to agencies/freelancers serving SMBs.
- Use Turkish demos with simple local business examples.
- Price in TRY for local buyers.
- Offer founder onboarding.
- Use WhatsApp/LinkedIn for first conversations.

### Do not do first

- Broad ads to SMB owners.
- Enterprise procurement.
- Long custom projects.
- Heavy support commitments without payment.

### Turkish message

> AKIS, AI ile üretilen müşteri projelerini onaylı kapsam, gerçek test kanıtı ve kontrollü GitHub teslimiyle profesyonel hale getirir.

Short version:

> AI hızlı üretir; AKIS kanıt olmadan teslim ettirmez.

---

## 14. Risk register

| Risk | Severity | Mitigation |
|---|---:|---|
| Existing platforms add similar gates | High | Build GitHub-compatible trust layer and agency workflow. |
| Users value speed more than trust | High | Sell report/handoff as client revenue tool, not abstract safety. |
| Verification becomes too complex | High | Start with simple explicit checks and constrained project types. |
| Direct SMB support overload | High | Use agencies as channel first. |
| “Verified” creates liability | Medium-high | Always define verified as passing listed checks at a timestamp. |
| BYO-key is too hard | Medium | BYO for agencies; managed credits later. |
| Too many features slow MVP | High | Keep P0 to approval, evidence, review, push gate, report. |

---

## 15. Moat hypothesis

AKIS cannot build a moat around model access. Models will commoditize.

The moat should be:

1. **Trust transcript graph:** structured record of every approval, check, review, and push event.
2. **Policy gate engine:** configurable rules for what can be marked done or pushed.
3. **Client-facing trust report:** a deliverable agencies can sell.
4. **Workflow templates:** repeatable verified project types.
5. **GitHub-native evidence:** PR comments/checks/reports attached to real repos.
6. **Local + global bridge:** Turkish accessibility with global developer workflows.

---

## 16. MVP launch checklist

Before calling the MVP ready to sell, AKIS should have:

- [ ] Landing page says “verified before GitHub” clearly.
- [ ] Demo shows a failed check blocking push.
- [ ] Spec approval is visible.
- [ ] Producer and verifier are visibly separate.
- [ ] Test/check evidence is visible.
- [ ] Human push approval is visible.
- [ ] Trust report can be copied/exported/shared.
- [ ] Agency Beta price is shown or offered.
- [ ] At least 2 design partners have used the workflow.
- [ ] At least 1 real payment or written paid commitment exists.

---

## 17. Source register

Checked on 2026-06-02.

| Topic | Source | URL | Confidence |
|---|---|---|---|
| AI code tools market size and enterprise governance demand | Mordor Intelligence | https://www.mordorintelligence.com/industry-reports/artificial-intelligence-code-tools-market | Medium |
| No-code AI platform market size | Fortune Business Insights | https://www.fortunebusinessinsights.com/no-code-ai-platform-market-110382 | Medium |
| Agentic AI market size | Fortune Business Insights | https://www.fortunebusinessinsights.com/agentic-ai-market-114233 | Medium |
| AI governance market size | Grand View Research | https://www.grandviewresearch.com/industry-analysis/ai-governance-market-report | Medium |
| EU AI Act risk/governance direction | European Commission | https://digital-strategy.ec.europa.eu/en/policies/regulatory-framework-ai | High |
| Cursor pricing | Cursor | https://cursor.com/pricing | High |
| Lovable pricing | Lovable | https://lovable.dev/pricing | High |
| Bolt pricing | Bolt | https://bolt.new/pricing | High |
| Replit pricing | Replit | https://replit.com/pricing | High |
| v0 pricing | Vercel v0 | https://v0.app/pricing | High |
| Devin pricing | Cognition Devin | https://devin.ai/pricing | High |
| Factory pricing | Factory | https://factory.ai/pricing | Medium-high |
| Windsurf pricing | Windsurf | https://windsurf.com/pricing | High |
| Qodo pricing | Qodo | https://www.qodo.ai/pricing/ | High |
| GitHub Copilot plan structure | GitHub | https://github.com/features/copilot/plans | High |
| Turkish low-code competitor context | Kuika | https://www.kuika.com/en | Medium |
| Turkish low-code/no-code competitor context | RIVER | https://river.com.tr/low-code-nedir/ | Medium |
| AI coding trust/adoption signal | Stack Overflow Developer Survey 2025 | https://survey.stackoverflow.co/2025/ai | Medium-high |

---

## 18. Final execution rule

Until the MVP has paying design partners, every product decision should be judged by one question:

> Does this make AKIS more credible as the verified delivery layer for AI-built client projects?

If yes, build it. If no, defer it.
