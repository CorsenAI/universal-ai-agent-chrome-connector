// A fake chat that streams an answer word by word, like a real web LLM UI.
// With `?nav=1`, the first message of a conversation replaces the document (a navigation to a
// conversation URL), the way many real chat sites open a new conversation: the answer then streams
// in the new document.
const prompt = document.getElementById('prompt')
const messages = document.getElementById('messages')
const query = new URLSearchParams(location.search)
const NAVIGATES_ON_FIRST_MESSAGE = query.has('nav') && !query.has('c')
let stopped = false

function answerFor(text) {
  if (text.includes('[TOOLS]')) {
    return { intro: 'I will look it up.', code: { lang: 'tool_calls', body: '{"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}' } }
  }
  return { intro: 'You sent ' + text.length + ' characters. Here is some code:', code: { lang: 'js', body: 'const answer = 42' }, outro: 'Anything else?' }
}

function element(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) node.setAttribute(key, value)
  node.append(...children)
  return node
}

/** Banner outside the <pre> (label, Copy and Download as div[role=button]); returns the <pre>. */
function bannerBlock(parent, lang) {
  const pre = element('pre')
  const banner = element('div', { class: 'banner' }, element('span', {}, lang), element('div', { role: 'button', tabindex: '0' }, 'Copy'), element('div', { role: 'button', tabindex: '0' }, 'Download'))
  parent.append(element('div', { class: 'code-block' }, banner, pre))
  return pre
}

/** Header row and Copy button inside the <pre>, code in <code class="language-…">; returns the <code>. */
function headerBlock(parent, lang) {
  const code = element('code', { class: 'language-' + lang })
  const header = element('div', { class: 'code-header' }, element('span', {}, lang === 'js' ? 'javascript' : lang), element('button', { type: 'button' }, 'Copy code'))
  parent.append(element('pre', {}, header, element('div', { class: 'code-body' }, code)))
  return code
}

async function submit() {
  const text = prompt.value
  if (!text.trim()) return
  prompt.value = ''
  if (NAVIGATES_ON_FIRST_MESSAGE) {
    sessionStorage.setItem('pending-message', text)
    location.assign(`${location.pathname}?nav=1&c=${Date.now()}`)
    return
  }
  await answer(text)
}

async function answer(text) {
  stopped = false
  const user = document.createElement('div')
  user.className = 'user'
  user.textContent = text
  messages.append(user)
  const answer = document.createElement('div')
  answer.className = 'answer'
  messages.append(answer)
  document.body.classList.add('streaming')
  const plan = answerFor(text)
  const p = document.createElement('p')
  answer.append(p)
  for (const word of plan.intro.split(' ')) {
    if (stopped) break
    p.textContent += (p.textContent ? ' ' : '') + word
    await new Promise((r) => setTimeout(r, 40))
  }
  // Code blocks carry the chrome real chat UIs draw around them, so the extraction is tested
  // against it: tool_calls get a banner outside the <pre> with div[role=button] controls and no
  // <code>; other code gets a header row with a Copy button inside the <pre>.
  const target = plan.code.lang === 'tool_calls' ? bannerBlock(answer, plan.code.lang) : headerBlock(answer, plan.code.lang)
  for (const char of plan.code.body) {
    if (stopped) break
    target.textContent += char
    if (Math.random() < 0.3) await new Promise((r) => setTimeout(r, 5))
  }
  if (plan.outro && !stopped) {
    const outro = document.createElement('p')
    outro.textContent = plan.outro
    answer.append(outro)
  }
  await new Promise((r) => setTimeout(r, 100))
  document.body.classList.remove('streaming')
}

prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void submit()
  }
})
document.getElementById('send').addEventListener('click', () => void submit())
document.getElementById('stop').addEventListener('click', () => { stopped = true })

// In that mode both documents open with an assistant greeting, as many chat sites do: an answer that
// already existed before the prompt, which a reader that lost its baseline would take for the reply.
if (query.has('nav')) {
  const greeting = element('div', { class: 'answer' }, element('p', {}, 'Hello! Ask me anything.'))
  messages.append(greeting)
}

// The conversation document: answer the message carried over the navigation.
const pending = sessionStorage.getItem('pending-message')
if (pending !== null && query.has('c')) {
  sessionStorage.removeItem('pending-message')
  setTimeout(() => void answer(pending), 300)
}
