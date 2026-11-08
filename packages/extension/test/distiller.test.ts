// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { redactionConfig } from '@corsen-ai/shared'
import { corsenDistill, type DistillOptions } from '../src/inpage/distiller'

const base: DistillOptions = { mode: 'page', startIndex: 1, maxChars: 100_000, scope: 'full', redaction: redactionConfig() }

function distill(html: string, options: Partial<DistillOptions> = {}): ReturnType<typeof corsenDistill> {
  document.body.innerHTML = html
  return corsenDistill({ ...base, ...options })
}

beforeEach(() => {
  delete (globalThis as { __corsenRefState?: unknown }).__corsenRefState
  document.body.innerHTML = ''
  document.title = 'Fixture'
})

describe('page mode', () => {
  it('renders headings, paragraphs, emphasis and links with refs', () => {
    const result = distill('<h1>Title</h1><p>Hello <strong>bold</strong> and <em>soft</em> <a href="https://example.com/docs">docs</a>.</p>')
    expect(result.markdown).toBe('# Title\n\nHello **bold** and *soft* [docs](https://example.com/docs) [ref=e1].')
    expect(result.refCount).toBe(1)
    expect(result.title).toBe('Fixture')
  })

  it('renders nested lists with indentation and ordered numbering', () => {
    const result = distill('<ul><li>One<ul><li>One.a</li></ul></li><li>Two</li></ul><ol start="3"><li><p>Three</p></li><li>Four</li></ol>')
    expect(result.markdown).toBe('- One\n  - One.a\n- Two\n\n3. Three\n4. Four')
  })

  it('renders tables and fenced code with language', () => {
    const result = distill(
      '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>A|B</td><td>2</td></tr></tbody></table><pre><code class="language-ts">const x = 1\n</code></pre>',
    )
    expect(result.markdown).toBe('| Name | Qty |\n| --- | --- |\n| A\\|B | 2 |\n\n```ts\nconst x = 1\n```')
  })

  it('lists form controls with labels, values and refs, masking secrets', () => {
    const result = distill(`
      <form>
        <label for="email">Email</label><input id="email" type="email" value="ada@example.com">
        <input type="password" name="pw" value="hunter2" aria-label="Password">
        <input name="otp_code" value="123456" placeholder="One-time code">
        <input autocomplete="cc-number" value="4111111111111111" aria-label="Card">
        <input type="checkbox" aria-label="Remember me" checked>
        <select aria-label="Country"><option>France</option><option selected>Germany</option></select>
        <button type="submit">Sign in</button>
      </form>`)
    expect(result.markdown).toContain('[textbox type=email "Email" = "ada@example.com"] [ref=e1]')
    expect(result.markdown).toContain('[textbox type=password "Password" = "••••••••"] [ref=e2]')
    expect(result.markdown).toContain('"One-time code" = "••••••••"')
    expect(result.markdown).toContain('"Card" = "••••••••"')
    expect(result.markdown).not.toContain('hunter2')
    expect(result.markdown).not.toContain('123456')
    expect(result.markdown).not.toContain('4111')
    expect(result.markdown).toContain('[checkbox "Remember me" checked]')
    expect(result.markdown).toContain('[select "Country" = "Germany" (options: France, Germany)]')
    expect(result.markdown).toContain('[button "Sign in"]')
  })

  it('skips hidden content, scripts and styles', () => {
    const result = distill('<p>Visible</p><p style="display:none">Hidden css</p><p hidden>Hidden attr</p><div aria-hidden="true">Hidden aria</div><script>var secret=1</script><style>p{}</style>')
    expect(result.markdown).toBe('Visible')
  })

  it('scrubs credentials from link URLs', () => {
    const result = distill('<a href="https://x.dev/cb?access_token=abc123&page=2">callback</a>')
    expect(result.markdown).not.toContain('abc123')
    expect(result.markdown).toContain('page=2')
  })

  it('keeps refs stable across snapshots and never reuses numbers', () => {
    document.body.innerHTML = '<button id="a">A</button><button id="b">B</button>'
    const first = corsenDistill(base)
    // Buttons are inline elements: siblings share a line, like a toolbar.
    expect(first.markdown).toBe('[button "A"] [ref=e1] [button "B"] [ref=e2]')
    document.getElementById('a')?.remove()
    document.body.insertAdjacentHTML('beforeend', '<button id="c">C</button>')
    const second = corsenDistill({ ...base, startIndex: first.nextIndex })
    expect(second.markdown).toBe('[button "B"] [ref=e2] [button "C"] [ref=e3]')
    expect(second.nextIndex).toBe(4)
  })

  it('honors the start index handed out by the service worker', () => {
    const result = distill('<button>X</button>', { startIndex: 40 })
    expect(result.markdown).toBe('[button "X"] [ref=e40]')
  })

  it('restricts to the main region and truncates honestly', () => {
    const scoped = distill('<nav><a href="/a">Nav</a></nav><main><h2>Main</h2><p>Body</p></main>', { scope: 'main' })
    expect(scoped.markdown).toBe('## Main\n\nBody')
    const long = distill(`<p>${'word '.repeat(200)}</p>`, { maxChars: 100 })
    expect(long.truncated).toBe(true)
    expect(long.markdown).toContain('…[truncated:')
  })

  it('reports the source size for the tokens-saved metric', () => {
    const result = distill(`<div class="wrapper"><div><div><span>${'x'.repeat(50)}</span></div></div></div>`)
    expect(result.sourceChars).toBeGreaterThan(result.markdown.length)
  })
})

describe('element mode (web-LLM answers)', () => {
  it('converts the last matching answer to Markdown blocks without refs or buttons', () => {
    const html = `
      <div class="answer"><p>Old answer</p></div>
      <div class="answer">
        <p>Here is code:</p>
        <pre><div><span>python</span><button>Copy code</button></div><code>print("hi")</code></pre>
        <ul><li>a</li><li>b</li></ul>
        <p>Keep &lt;read_file&gt;raw tags&lt;/read_file&gt; as text.</p>
      </div>`
    const result = distill(html, { mode: 'element', selector: '.answer' })
    expect(result.found).toBe(true)
    expect(result.blocks).toEqual(['Here is code:', '```python\nprint("hi")\n```', '- a\n- b', 'Keep <read_file>raw tags</read_file> as text.'])
    expect(result.refCount).toBe(0)
  })

  it('reports not found', () => {
    expect(distill('<p>x</p>', { mode: 'element', selector: '.nothing' }).found).toBe(false)
  })

  it('keeps a tool_calls fence intact', () => {
    const result = distill('<div class="a"><pre><code class="language-tool_calls">{"tool_calls":[{"name":"x","arguments":{}}]}</code></pre></div>', { mode: 'element', selector: '.a' })
    expect(result.blocks).toEqual(['```tool_calls\n{"tool_calls":[{"name":"x","arguments":{}}]}\n```'])
  })
})

/**
 * Chat UIs draw a header row (language label, "Copy", "Download") around their code blocks, inside
 * or outside the <pre>, with or without <code>. None of it may reach the answer, and above all not
 * the JSON of a tool_calls block. Structures mirror the shapes those UIs use.
 */
describe('element mode: code-block chrome drawn by chat UIs', () => {
  const json = '{"tool_calls":[{"name":"read_file","arguments":{"path":"src/a.ts"}}]}'
  const fenced = (lang: string): string => `\`\`\`${lang}\n${json}\n\`\`\``
  const answer = (html: string): string[] => distill(html, { mode: 'element', selector: '.a' }).blocks

  it('header row and copy button inside <pre>, code in <code class="language-…">', () => {
    const blocks = answer(
      `<div class="a"><p>Calling the tool.</p><pre><div><div class="hdr">tool_calls</div><div class="sticky"><div><button aria-label="Copy"><svg></svg>Copy</button></div></div><div class="body"><code class="whitespace-pre! language-tool_calls"><span>${json}</span></code></div></div></pre></div>`,
    )
    expect(blocks).toEqual(['Calling the tool.', fenced('tool_calls')])
  })

  it('language header and copy button outside <pre>', () => {
    const blocks = answer(
      `<div class="a"><p>Here it is.</p><div class="widget"><div class="hdr"><span>json</span></div><div class="sticky"><button type="button">Copy</button></div><div><pre class="code-block__code"><code class="language-json">${json}</code></pre></div></div><p>Done.</p></div>`,
    )
    expect(blocks).toEqual(['Here it is.', fenced('json'), 'Done.'])
  })

  it('banner with div[role=button] controls and a <pre> without <code>', () => {
    const blocks = answer(
      `<div class="a"><div class="md-code-block"><div class="banner-wrap"><div class="banner"><div><span>tool_calls</span></div><div><div role="button" tabindex="0">Copy</div><div role="button" tabindex="0">Download</div></div></div></div><pre>${json}</pre></div></div>`,
    )
    expect(blocks).toEqual([fenced('tool_calls')])
  })

  it('upper-case label and an icon button whose ligature text is not code', () => {
    const blocks = answer(
      `<div class="a"><div class="code-block"><div class="decoration"><span>JSON</span><div class="buttons"><button aria-label="Copy code"><mat-icon>content_copy</mat-icon></button></div></div><div class="internal"><div><pre><code role="text" data-test-id="code-content">${json}</code></pre></div></div></div></div>`,
    )
    expect(blocks).toEqual([fenced('json')])
  })

  it('one div per line, header row inside <pre> and no <code>', () => {
    const blocks = answer(
      '<div class="a"><pre><div class="wrap"><div class="hdr">python</div><div><button>Copy</button></div><div class="cm-editor"><div class="cm-gutters" aria-hidden="true"><div>1</div><div>2</div></div><div class="cm-content"><div class="cm-line">def f():</div><div class="cm-line">    return 1</div></div></div></div></pre></div>',
    )
    expect(blocks).toEqual(['```python\ndef f():\n    return 1\n```'])
  })

  it('drops line-number gutters inside <code>', () => {
    const blocks = answer(
      '<div class="a"><pre><code class="language-js"><span class="react-syntax-highlighter-line-number" style="user-select: none">1</span>const a = 1\n<span class="react-syntax-highlighter-line-number" style="user-select: none">2</span>const b = 2</code></pre></div>',
    )
    expect(blocks).toEqual(['```js\nconst a = 1\nconst b = 2\n```'])
  })

  it('keeps a one-word paragraph next to a code widget', () => {
    const blocks = answer('<div class="a"><p>Example</p><div class="w"><div><span>sh</span><button>Copy</button></div><pre><code>ls -la</code></pre></div></div>')
    expect(blocks).toEqual(['Example', '```sh\nls -la\n```'])
  })

  it('does not take an answer with prose and a stray button for a code widget', () => {
    expect(answer('<div class="a"><p>Sure</p><pre><code>ls</code></pre><button>Copy</button></div>')).toEqual(['Sure', '```\nls\n```'])
  })

  it('keeps a header that is not a label as text, outside the fence', () => {
    const blocks = answer(`<div class="a"><div class="w"><div>Run this in src/app</div><button>Copy</button><pre><code>${json}</code></pre></div></div>`)
    expect(blocks).toEqual(['Run this in src/app', `\`\`\`\n${json}\n\`\`\``])
  })
})
