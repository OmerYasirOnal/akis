import type { SpecArtifact } from '@akis/shared'

/**
 * Turn a spec's acceptance criteria (Given/When/Then lines in the body) into a
 * Gherkin .feature file — one Scenario per Given→When→Then triple. If the body has
 * no G/W/T, emit a single smoke scenario so there is always ≥1 runnable scenario.
 * Pure (string → string).
 */
export function generateFeature(spec: SpecArtifact): string {
  const scenarios = parseScenarios(spec.body)
  const lines: string[] = [`Feature: ${spec.title}`, '']
  if (scenarios.length === 0) {
    lines.push('  Scenario: app loads', '    Given the app is running', '    When I open the home page', '    Then the page renders without error', '')
  } else {
    scenarios.forEach((sc, i) => {
      lines.push(`  Scenario: ${sc.name || `criterion ${i + 1}`}`)
      for (const step of sc.steps) lines.push(`    ${step}`)
      lines.push('')
    })
  }
  return lines.join('\n')
}

interface Scenario { name: string; steps: string[] }

const STEP = /^\s*[-*]?\s*(Given|When|Then|And|But)\b\s*(.*)$/i

function parseScenarios(body: string): Scenario[] {
  const scenarios: Scenario[] = []
  let current: Scenario | undefined
  for (const raw of body.split('\n')) {
    const m = STEP.exec(raw)
    if (!m) continue
    const keyword = m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase()
    const text = m[2]!.trim()
    if (keyword === 'Given') {
      // A new Given starts a new scenario.
      current = { name: text.slice(0, 60), steps: [] }
      scenarios.push(current)
    }
    if (!current) { current = { name: text.slice(0, 60), steps: [] }; scenarios.push(current) }
    current.steps.push(`${keyword} ${text}`.trim())
  }
  return scenarios.filter(s => s.steps.length > 0)
}
