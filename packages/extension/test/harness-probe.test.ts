// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { resolveHarness } from '../src/harnesses/registry'
import { corsenDistill } from '../src/inpage/distiller'
import { corsenHarnessProbe, type ProbeBaseline, type ProbeOptions, type ProbeResult } from '../src/inpage/harness-probe'

const chatgpt = resolveHarness('chatgpt', 'https://chatgpt.com/', {})

function probe(op: ProbeOptions['op'], baseline?: ProbeBaseline | null): ProbeResult {
  return corsenHarnessProbe({ ...chatgpt.selectors, streamingAttribute: chatgpt.streamingAttribute, op, maxChars: 100_000, baseline: baseline ?? undefined })
}

/**
 * chatgpt.com signed out (markup observed 2026-11-09): a plain textarea, one composer button that
 * becomes the stop control while streaming, answers as transcript list items.
 */
function signedOut(answers: readonly string[], streaming: boolean): string {
  const button = streaming
    ? '<button type="button" data-composer-submit aria-label="Stop generating" data-stop-generating>Stop generating</button>'
    : '<button type="submit" data-composer-submit aria-label="Send message">Send message</button>'
  const items = answers
    .map(
      (answer, index) => `<li data-message-role="user"><div data-user-message-bubble><p data-user-message-copy>Question ${index + 1}</p></div></li>
         <li data-message-role="assistant" ${streaming && index === answers.length - 1 ? 'data-message-streaming' : 'data-message-complete data-assistant-content-started'}>
           <div><div data-assistant-markdown data-assistant-markdown-root><section><p>${answer}</p></section></div></div>
           <button type="button" aria-label="Copy response">Copy response</button>
         </li>`,
    )
    .join('')
  return `<form><textarea id="mobile-composer-prompt" name="prompt" placeholder="Ask ChatGPT"></textarea>${button}</form>
    <ol data-conversation-transcript>${items}</ol>`
}

/** chatgpt.com signed in: the long-standing markup the definition was written for. */
function signedIn(answer: string | null): string {
  const turn = answer === null ? '' : `<article data-testid="conversation-turn-2"><div data-message-author-role="assistant"><div class="markdown prose"><p>${answer}</p></div></div></article>`
  return `<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button>${turn}`
}

beforeEach(() => {
  document.body.innerHTML = ''
  // The probe only looks at visible elements; a DOM without layout reports empty boxes.
  Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 10, top: 10, left: 10, width: 100, height: 20, right: 110, bottom: 30, toJSON: () => ({}) })
  Element.prototype.scrollIntoView = () => undefined
  ;(globalThis as { __corsenDistill?: unknown }).__corsenDistill = corsenDistill
})

describe('web-chat probe with the ChatGPT definition', () => {
  it('drives the signed-out application: textarea, composer button as stop control, transcript items', () => {
    document.body.innerHTML = signedOut([], false)
    const prepared = probe('prepare')
    expect(prepared.ok).toBe(true)
    expect(prepared.inputTag).toBe('textarea')
    expect(prepared.send).not.toBeNull()
    expect(prepared.stop).toBeNull()
    expect(prepared.baseline).not.toBeNull()

    document.body.innerHTML = signedOut(['PO'], true)
    const streaming = probe('poll', prepared.baseline)
    expect(streaming.stop).not.toBeNull()
    expect(streaming.newest?.blocks).toEqual(['PO'])

    document.body.innerHTML = signedOut(['PONG'], false)
    const done = probe('poll', prepared.baseline)
    expect(done.stop).toBeNull()
    expect(done.newest?.blocks).toEqual(['PONG'])
    expect(done.newest?.textLength).toBe(4)
  })

  it('still reads the signed-in application', () => {
    document.body.innerHTML = signedIn(null)
    const prepared = probe('prepare')
    expect(prepared.inputTag).toBe('div[contenteditable]')
    expect(prepared.send).not.toBeNull()

    document.body.innerHTML = signedIn('PONG')
    const done = probe('poll', prepared.baseline)
    expect(done.newest?.blocks).toEqual(['PONG'])
    expect(done.stop).toBeNull()
  })

  it('ignores answers that were already there, even after the document was replaced', () => {
    document.body.innerHTML = signedOut(['old answer'], false)
    const prepared = probe('prepare')
    expect(probe('poll', prepared.baseline).newest).toBeNull()

    // The site re-renders the same conversation in a new document (new elements, same content).
    document.body.innerHTML = signedOut(['old answer'], false)
    expect(probe('poll', prepared.baseline).newest).toBeNull()

    document.body.innerHTML = signedOut(['old answer', 'new answer'], true)
    const fresh = probe('poll', prepared.baseline)
    expect(fresh.newest?.blocks).toEqual(['new answer'])
    expect(fresh.stop).not.toBeNull()
  })

  it('reads any answer when no baseline is known', () => {
    document.body.innerHTML = signedOut(['PONG'], false)
    expect(probe('poll', null).newest?.blocks).toEqual(['PONG'])
    expect(probe('poll', null).ok).toBe(true)
  })
})
