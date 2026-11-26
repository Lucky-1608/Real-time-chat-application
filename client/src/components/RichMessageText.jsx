import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import hljs from 'highlight.js/lib/core';

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: ['p', 'strong', 'em', 'code', 'pre', 'a', 'ul', 'ol', 'li', 'blockquote', 'br'],
  attributes: {
    a: ['href'],
    code: ['className'],
  },
  protocols: {
    href: ['http', 'https', 'mailto'],
  },
};

const LOADED_LANGS = new Map();

async function ensureLanguage(lang) {
  if (!lang || LOADED_LANGS.has(lang)) return LOADED_LANGS.get(lang) || false;
  const loaders = {
    javascript: () => import('highlight.js/lib/languages/javascript'),
    js: () => import('highlight.js/lib/languages/javascript'),
    typescript: () => import('highlight.js/lib/languages/typescript'),
    ts: () => import('highlight.js/lib/languages/typescript'),
    python: () => import('highlight.js/lib/languages/python'),
    py: () => import('highlight.js/lib/languages/python'),
    json: () => import('highlight.js/lib/languages/json'),
    bash: () => import('highlight.js/lib/languages/bash'),
    sh: () => import('highlight.js/lib/languages/bash'),
    css: () => import('highlight.js/lib/languages/css'),
    sql: () => import('highlight.js/lib/languages/sql'),
  };
  const loader = loaders[lang.toLowerCase()];
  if (!loader) {
    LOADED_LANGS.set(lang, false);
    return false;
  }
  try {
    const mod = await loader();
    hljs.registerLanguage(lang.toLowerCase(), mod.default);
    LOADED_LANGS.set(lang, true);
    return true;
  } catch {
    LOADED_LANGS.set(lang, false);
    return false;
  }
}

function HighlightedCode({ className, children }) {
  const match = /language-([a-zA-Z0-9_-]+)/.exec(className || '');
  const lang = match?.[1] || '';
  const codeText = String(children).replace(/\n$/, '');
  const [copied, setCopied] = useState(false);
  const [highlightedNodes, setHighlightedNodes] = useState(null);

  useEffect(() => {
    let active = true;
    if (!lang) return undefined;
    ensureLanguage(lang).then((ok) => {
      if (!active || !ok) return;
      try {
        const res = hljs.highlight(codeText, { language: lang.toLowerCase() });
        // Parse highlighted tokens safely without dangerouslySetInnerHTML
        const parser = new DOMParser();
        const doc = parser.parseFromString(res.value, 'text/html');
        const spans = Array.from(doc.body.childNodes).map((node, idx) =>
          node.nodeType === 3 ? (
            node.textContent
          ) : (
            <span key={idx} className={node.className || undefined}>
              {node.textContent}
            </span>
          )
        );
        setHighlightedNodes(spans);
      } catch {
        // Fallback to plain code text
      }
    });
    return () => {
      active = false;
    };
  }, [lang, codeText]);

  function handleCopy() {
    navigator.clipboard?.writeText(codeText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  if (!match) {
    return <code className={className}>{children}</code>;
  }

  return (
    <div style={{ position: 'relative', margin: '0.35rem 0' }}>
      <button
        type="button"
        onClick={handleCopy}
        style={{
          position: 'absolute',
          top: '4px',
          right: '6px',
          fontSize: '0.7rem',
          padding: '2px 6px',
          cursor: 'pointer',
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre style={{ margin: 0, padding: '0.6rem', overflowX: 'auto', borderRadius: '6px', background: 'rgba(0,0,0,0.28)' }}>
        <code className={className}>{highlightedNodes || codeText}</code>
      </pre>
    </div>
  );
}

export default function RichMessageText({ text }) {
  if (!text) return null;
  return (
    <ReactMarkdown
      rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
      components={{
        a({ href, children }) {
          return (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          );
        },
        code({ className, children }) {
          return <HighlightedCode className={className}>{children}</HighlightedCode>;
        },
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
