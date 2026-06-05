import { memo, isValidElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from '../i18n/I18nContext.js'
import { CopyButton } from './CopyButton.js'

/**
 * The SINGLE markdown renderer for the cosmic UI.
 *
 * Security: react-markdown does NOT parse raw HTML by default (no `rehype-raw`), so LLM
 * output can never inject `<script>`/markup — and we never touch `dangerouslySetInnerHTML`.
 * This is the only place markdown is turned into DOM, so styling + sanitization stay
 * centralized; chat bubbles, the spec card, and (later) docs all reuse it.
 *
 * Theming: tuned for the dark teal/violet theme — readable body, teal inline code &
 * links, violet-tinted headings, soft rules. Links open in a new tab with rel=noreferrer.
 */
const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-lg font-bold text-slate-100 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-4 mb-2 text-base font-bold text-violet-200 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-sm font-semibold uppercase tracking-wide text-violet-300/90 first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-slate-50">{children}</strong>,
  em: ({ children }) => <em className="italic text-slate-200">{children}</em>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-[#07D1AF]/70">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-[#07D1AF]/70">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  hr: () => <hr className="my-3 border-white/10" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-[#07D1AF]/50 pl-3 text-slate-300/90 italic">{children}</blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener"
      className="font-medium text-[#07D1AF] underline decoration-[#07D1AF]/40 underline-offset-2 hover:decoration-[#07D1AF]">{children}</a>
  ),
  code: ({ className, children }) => {
    // Fenced blocks carry a language-* class; inline code does not. Style them distinctly.
    const isBlock = typeof className === 'string' && className.includes('language-')
    if (isBlock) {
      return <code className={`${className ?? ''} block text-[13px] leading-relaxed`}>{children}</code>
    }
    return <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[0.85em] text-[#07D1AF]">{children}</code>
  },
  pre: (props) => <PreBlock>{props.children}</PreBlock>,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-white/10 bg-white/[0.04] px-2 py-1 text-left font-semibold text-slate-100">{children}</th>,
  td: ({ children }) => <td className="border border-white/10 px-2 py-1 text-slate-200">{children}</td>,
}

/**
 * Flatten a React node tree to its visible text. WHY the node tree and NOT the DOM: a fenced
 * block's text is read straight from the ALREADY-ESCAPED React children (the <code> element's
 * string child), never via innerHTML/textContent of a real node — so a `<script>` written inside
 * a fence stays literal text in the copied payload, preserving the rehype-raw-free XSS guarantee.
 */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

/** A fenced code block with a copy-overlay button (one per block). Pulled out so it can call
 *  hooks (useI18n) and extract the block's text from the React children for copying. */
function PreBlock({ children }: { children?: ReactNode }) {
  const { t } = useI18n()
  return (
    // `relative` anchors the overlay; `pr-10` keeps the button off the code text.
    <pre className="relative my-2 overflow-x-auto rounded-lg border border-white/10 bg-slate-950/60 p-3 pr-10 font-mono text-slate-200">
      {children}
      <CopyButton text={nodeText(children)} label={t('copy.codeBlock')} className="absolute right-2 top-2" />
    </pre>
  )
}

export const Markdown = memo(function Markdown({ content, className }: { content: string; className?: string }): ReactNode {
  return (
    <div className={`break-words text-[0.9375rem] text-slate-200 ${className ?? ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>{content}</ReactMarkdown>
    </div>
  )
})
