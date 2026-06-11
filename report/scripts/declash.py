import re
# Replace SPACED dashes between words with proper report punctuation.
# NEVER touches non-spaced dashes (e.g. the title "INTELLIGENCE–POWERED",
# hyphenated compounds like multi-agent, end-to-end, AI-powered).
EMEN = '–—'  # en dash, em dash

def declash(text):
    if not text:
        return text
    t = text
    # Normalize any spaced en-dash to spaced em-dash first for uniform handling
    t = re.sub(r' – ', ' — ', t)
    # spaced single hyphen between word chars -> comma (e.g. "Models - LLM", "[optional - to be completed]")
    t = re.sub(r'(\w) - (\w)', r'\1, \2', t)
    # Handle em-dashes per paragraph: pairs -> parentheses, singles -> colon/comma
    while ' — ' in t:
        n = t.count(' — ')
        if n >= 2:
            # parenthesize the clause between the first pair
            first = t.index(' — ')
            second = t.index(' — ', first + 3)
            left = t[:first]
            mid = t[first+3:second]
            right = t[second+3:]
            t = f"{left} ({mid}){right if right.startswith((',', '.', ';', ':')) else ' ' + right.lstrip()}"
        else:
            i = t.index(' — ')
            left, right = t[:i], t[i+3:]
            # contrast emphasis -> comma; otherwise -> colon
            if re.match(r'(not|rather|once|either|each|including|measuring|whether|where|completeness|orchestrator)\b', right, re.I) and not re.match(r'\w+\b', left.split()[-1] if left.split() else '') is None and len(left.split())>4:
                # long left + clarifier right -> colon for enumerations, comma for "not"
                t = (left + ', ' + right) if right.lower().startswith('not ') else (left + ': ' + right)
            else:
                t = left + ': ' + right
    return t

if __name__ == '__main__':
    tests = [
      "AKIS — Workflow Orchestrator",
      "Completeness — whether all required features and acceptance criteria are present",
      "specialised agents — Scribe, Proto, Critic, and Trace — while maintaining centralised orchestration",
      "directly from the GitHub repository — not from Proto's in-memory output",
      "two stages of the pipeline — once after specification generation and once after code generation; and Trace",
      "across six dimensions — completeness, ambiguity, testability — and produces a scored review",
      "(Large Language Models - LLM)",
      "[optional - to be completed]",
      "ARTIFICIAL INTELLIGENCE–POWERED INTERACTIVE",  # must stay (no spaces)
    ]
    for s in tests:
        print(repr(s), "->", repr(declash(s)))
