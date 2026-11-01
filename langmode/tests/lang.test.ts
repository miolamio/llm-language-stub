import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On, RenderElement } from 'claude-code'

import { chunks, detect, keepsLiterals, quote, repairInlineCode, runaway, segments, sentences, unquote } from '../hooks/translate'

type Req = { source: string; target: string; text: string }

// A fake TranslateGemma service: tags the text with the target language and
// records what it was sent. `mangle` drops inline code to simulate a bad answer.
function fakeService(on: On, seen: Req[], mangle = false) {
  const clock = mock.clock(on)
  on('http.fetch', async ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as {
      messages: { content: { source_lang_code: string; target_lang_code: string; text: string }[] }[]
    }
    const p = body.messages[0]!.content[0]!
    // The mod sends the text in «»; the service answers in straight quotes.
    const text = p.text.slice(1, -1)
    seen.push({ source: p.source_lang_code, target: p.target_lang_code, text })
    const out = `"[${p.target_lang_code}] ${mangle ? text.replace(/`[^`]*`/g, 'X') : text}"`
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: out } }] }) } }
  })
  return clock
}

// The reply worker starts with the session: a test answers session.start beneath
// the plugin and raises it (every `on` comes before the first `$` call).
const sessionStart = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

// The manifest ships no service URL; tests point the mod at a placeholder the
// fake service answers.
const withService = { options: { url: 'http://translate.test/v1/chat/completions' } }

function drawText(on: On) {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const text = 'text' in e.props && typeof e.props.text === 'string' ? e.props.text : ''
    return h(Text, null, text) as RenderElement
  })
}

describe('translate helpers', () => {
  test('detects languages from prose, not code', () => {
    expect(detect('Исправь тест в `src/app.ts`')).toBe('ru')
    expect(detect('Виправ тест, будь ласка, і перевір')).toBe('uk')
    expect(detect('No cambies "Delete account"; modifica solo el tooltip.')).toBe('es')
    expect(detect('لا تحذف ملفات migrations؛ عدّل الاختبارات فقط.')).toBe('ar')
    expect(detect('fix the build in `src/ветка.ts`')).toBe('en')
    expect(detect('```\nпривет\n```')).toBe('en')
  })

  test('inline code edited by the model is put back from the source', () => {
    expect(repairInlineCode('Run `npm test -- session` in `a/`.', 'Запусти `npm test --session` в `a/`.')).toBe('Запусти `npm test -- session` в `a/`.')
    expect(repairInlineCode('Run `a` and `b`.', 'Запусти `a`.')).toBe('Запусти `a`.')
    // Backticks the model turned into quotes, or dropped, come back.
    expect(repairInlineCode('Open `a.ts` and `b.ts`.', 'Открой `a.ts` и "b.ts".')).toBe('Открой `a.ts` и `b.ts`.')
    expect(repairInlineCode('Run `npm test`.', 'Запусти npm test.')).toBe('Запусти `npm test`.')
  })

  test('a line longer than the limit is cut by sentences, and joins back', () => {
    const line = 'Первое предложение тут. '.repeat(10).trim()
    const u = chunks(line, 60)
    expect(u.every(x => x.text.length <= 60)).toBe(true)
    expect(u.map((x, i) => (i === 0 ? '' : x.sep) + x.text).join('')).toBe(line)
  })

  test('segments keep fenced code whole and mark it', () => {
    const s = segments('Текст\n\n```sh\nnpm test\n\nmore\n```\n\n---')
    expect(s.map(x => x.code)).toEqual([false, true, true])
    expect(s[1]!.text).toBe('```sh\nnpm test\n\nmore\n```')
  })

  test('literal check catches lost inline code, URLs and link targets', () => {
    expect(keepsLiterals('run `npm test` see [a](b.md)', 'запусти `npm test` см. [а](b.md)')).toBe(true)
    expect(keepsLiterals('run `npm test`', 'запусти npm test')).toBe(false)
    expect(keepsLiterals('open https://x.io/a', 'открой https://x.io/b')).toBe(false)
    expect(keepsLiterals('see https://x.io/a for details', 'см. https://x.io/a.')).toBe(true)
    // A repeated span merged into one loses nothing.
    expect(keepsLiterals('call `fn`, then `fn` again', 'вызови `fn` дважды')).toBe(true)
  })

  test('sentences cut after punctuation and lines, never inside inline code', () => {
    const t = 'Напиши `a.b. c` функцию. Затем тест!\nИ всё…  Готово'
    expect(sentences(t)).toEqual(['Напиши `a.b. c` функцию. ', 'Затем тест!\n', 'И всё…  ', 'Готово'])
    expect(sentences(t).join('')).toBe(t)
    expect(sentences('одно')).toEqual(['одно'])
  })

  test('the translation is taken out of the quotes it was sent in', () => {
    expect(quote('Привет')).toBe('«Привет»')
    expect(unquote('"Hi! How are you?"', 'Привет! Как дела?')).toBe('Hi! How are you?')
    expect(unquote('«Привет, "мир"»', 'Hello, "world"')).toBe('Привет, "мир"')
    expect(unquote('"## Сводка\n\nТекст."\n', '## Summary\n\nText.')).toBe('## Сводка\n\nТекст.')
    expect(unquote("'Installation'", 'Установка')).toBe('Installation')
    expect(unquote('"Add an "Installation" section."', 'Добавь раздел «Установка».')).toBe('Add an "Installation" section.')
    // The wrapper dropped around a text with quotes of its own: taken whole.
    expect(unquote('"Session expired" - find this line.', '"Сессия истекла" — найди эту строку.')).toBe('"Session expired" - find this line.')
    expect(unquote('"Session expired" - find it, or say "no"', '"Сессия истекла" — найди, или скажи "нет"')).toBe('"Session expired" - find it, or say "no"')
    // Markdown structure comes back unwrapped, sometimes with the closing quote only.
    expect(unquote('## Сводка\n\n- Сначала код.', '## Summary\n\n- Sync code first.')).toBe('## Сводка\n\n- Сначала код.')
    expect(unquote('## Сводка\n\nТекст."', '## Summary\n\nText.')).toBe('## Сводка\n\nТекст.')
    expect(unquote('1. Первый\n2. Второй', '1. First\n2. Second')).toBe('1. Первый\n2. Второй')
    expect(unquote('Summary: the loop has phases.', '## Summary')).toBeUndefined()
    expect(unquote('""Translate to English: \'The session has expired.\'""', 'Переведи на английский: «срок действия сессии истёк»')).toBe("Translate to English: 'The session has expired.'")
    expect(unquote('""Hi" and "bye""', '"Привет" и "пока"')).toBe('"Hi" and "bye"')
    expect(unquote('"Translate to English: \'The session has expired.\'"\n', 'Переведи на английский: «срок действия сессии истёк»')).toBe("Translate to English: 'The session has expired.'")
    expect(unquote('"Don\'t change anything."', 'Ничего не меняй.')).toBe("Don't change anything.")
    expect(unquote('ESLint is a tool.', 'Что такое eslint?')).toBeUndefined()
    expect(unquote('"What is ESLint?" ESLint is a tool.', 'Что такое eslint?')).toBeUndefined()
  })

  test('a translation far longer than its source is an answer, not a translation', () => {
    expect(runaway('Напиши функцию debounce.', 'Write a debounce function.')).toBe(false)
    expect(runaway('Напиши функцию debounce.', 'Write a debounce function.\n\n```ts\n' + 'x'.repeat(200) + '\n```')).toBe(true)
  })
})

describe('lang-bridge', () => {
  test('no service URL configured: the mod is off', async ($, on) => {
    const seen: Req[] = []
    const got: string[] = []
    fakeService(on, seen)
    on('prompt.submit', ($, e) => (got.push(e.text), { text: e.text }))
    await $.prompt.submit({ text: 'почини сборку', wait: false, origin: { kind: 'composer' } })
    expect(got).toEqual(['почини сборку'])
    expect(seen).toEqual([])
  })

  test('prompt reaches the model in English; the row shows the original', withService, async ($, on) => {
    const seen: Req[] = []
    let modelSaw = ''
    fakeService(on, seen)
    drawText(on)
    on('prompt.submit', ($, e) => ((modelSaw = e.text), { text: e.text }))

    const typed = 'Исправь тест в `src/app.ts`\n\n```sh\nnpm test\n```'
    await $.prompt.submit({ text: typed, wait: false, origin: { kind: 'composer' } })

    expect(seen).toEqual([{ source: 'ru', target: 'en', text: 'Исправь тест в `src/app.ts`' }])
    expect(modelSaw).toBe('[en] Исправь тест в `src/app.ts`\n\n```sh\nnpm test\n```')

    const ui = await $.ui.mount({
      plugin: 'lang-bridge',
      surface: 'terminal',
      component: 'UserMessage',
      props: { text: modelSaw, origin: { kind: 'composer' }, isExpanded: false },
    })
    expect(await ui.find({ type: 'Text', text: `${typed}\n\n🌐 → EN` })).toBeDefined()
    await ui.unmount()
  })

  test('English prompts and slash commands pass untouched', withService, async ($, on) => {
    const seen: Req[] = []
    const got: string[] = []
    fakeService(on, seen)
    on('prompt.submit', ($, e) => (got.push(e.text), { text: e.text }))
    await $.prompt.submit({ text: 'fix the build', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: '/compact сейчас', wait: false, origin: { kind: 'composer' } })
    expect(got).toEqual(['fix the build', '/compact сейчас'])
    expect(seen).toEqual([])
  })

  test('replies show a pending mark, then the translation in the language of the last prompt', withService, async ($, on) => {
    const seen: Req[] = []
    const clock = fakeService(on, seen)
    drawText(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(sessionStart)
    await $.prompt.submit({ text: 'Hola, ¿qué tal? arregla el test', wait: false, origin: { kind: 'composer' } })

    const reply = 'Run this:\n\n```sh\nnpm test\n```\n\nThen open `README.md`.'
    const ui = await $.ui.mount({ plugin: 'lang-bridge', surface: 'terminal', component: 'AssistantMessage', props: { text: reply, isFirstOfReply: true } })
    expect(await ui.find({ type: 'Text', text: `${reply}\n\n*🌐 ⏳ traduciendo…*` })).toBeDefined()
    await clock.advance(150)
    expect(await ui.find({ type: 'Text', text: '[es] Run this:\n\n```sh\nnpm test\n```\n\n[es] Then open `README.md`.\n\n*🌐 traducción automática · `/lang original` — ver el original*' })).toBeDefined()
    await ui.unmount()
    // One call per prose chunk; code never sent.
    expect(seen.filter(r => r.target === 'es').map(r => r.text)).toEqual(['Run this:', 'Then open `README.md`.'])
  })

  test('an old reply keeps its language after a prompt in another language', withService, async ($, on) => {
    const seen: Req[] = []
    const clock = fakeService(on, seen)
    drawText(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(sessionStart)
    await $.prompt.submit({ text: 'Привет, почини тест', wait: false, origin: { kind: 'composer' } })
    const ui = await $.ui.mount({ plugin: 'lang-bridge', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Done.', isFirstOfReply: true } })
    await clock.advance(150)
    expect(await ui.find({ type: 'Text', text: '[ru] Done.\n\n*🌐 машинный перевод · `/lang original` — оригинал*' })).toBeDefined()
    await $.prompt.submit({ text: 'Hola, ¿qué tal? arregla el test', wait: false, origin: { kind: 'composer' } })
    await clock.advance(150)
    expect(await ui.find({ type: 'Text', text: '[ru] Done.\n\n*🌐 машинный перевод · `/lang original` — оригинал*' })).toBeDefined()
    await ui.unmount()
  })

  test('a reply left wholly untranslated is marked and has no machine-translation footer', withService, async ($, on) => {
    const seen: Req[] = []
    const clock = fakeService(on, seen, true)
    drawText(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(sessionStart)
    await $.prompt.submit({ text: 'Привет', wait: false, origin: { kind: 'composer' } })
    const ui = await $.ui.mount({ plugin: 'lang-bridge', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Open `a.ts`.', isFirstOfReply: true } })
    await clock.advance(150)
    expect(await ui.find({ type: 'Text', text: '> ⚠️ *Фрагмент не переведён — показан оригинал*\n\nOpen `a.ts`.' })).toBeDefined()
    // The service is asked again later.
    const before = seen.length
    await clock.advance(30_000)
    await clock.advance(150)
    expect(seen.length).toBe(before + 1)
    // ...three times in all, then left alone.
    for (const ms of [60_000, 90_000, 120_000, 300_000]) {
      await clock.advance(ms)
      await clock.advance(150)
    }
    expect(seen.length).toBe(before + 3)
    await ui.unmount()
  })

  test('status line shows the pair, work in progress and problems', withService, async ($, on) => {
    const status: (string | undefined)[] = []
    on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
    mock.clock(on)
    on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.prompt.submit({ text: 'Привет, почини сборку', wait: false, origin: { kind: 'composer' } })
    expect(status).toContain('🌐 LangMode RU⇄EN')
    expect(status).toContain('🌐 LangMode RU⇄EN ⏳')
    expect(status[status.length - 1]).toBe('🌐 LangMode RU⇄EN ⚠ 1')
  })

  test('a prompt the service answers instead of translating is retried sentence by sentence', withService, async ($, on) => {
    mock.clock(on)
    const seen: string[] = []
    on('http.fetch', async ($, e) => {
      const text = (JSON.parse(e.init?.body ?? '{}') as { messages: { content: { text: string }[] }[] }).messages[0]!.content[0]!.text.slice(1, -1)
      seen.push(text)
      // Two imperatives together set the model off; one at a time it translates.
      const out = text.includes('. ') ? `"EN ${text}"\n\n${'answer '.repeat(80)}` : `"EN ${text}"`
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: out } }] }) } }
    })
    let modelSaw = ''
    on('prompt.submit', ($, e) => ((modelSaw = e.text), { text: e.text }))
    await $.prompt.submit({ text: 'Напиши функцию `debounce`. Затем покажи команду.', wait: false, origin: { kind: 'composer' } })
    expect(seen).toEqual(['Напиши функцию `debounce`. Затем покажи команду.', 'Напиши функцию `debounce`.', 'Затем покажи команду.'])
    expect(modelSaw).toBe('EN Напиши функцию `debounce`. EN Затем покажи команду.')
  })

  test('an answer that comes back without the quotes is not taken for a translation', withService, async ($, on) => {
    mock.clock(on)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ESLint is a tool.' } }] }) } }))
    let modelSaw = ''
    on('prompt.submit', ($, e) => ((modelSaw = e.text), { text: e.text }))
    await $.prompt.submit({ text: 'Ответь одним предложением: что такое eslint?', wait: false, origin: { kind: 'composer' } })
    expect(modelSaw).toBe('Ответь одним предложением: что такое eslint?')
  })

  test('a single sentence the service answers is sent in the original', withService, async ($, on) => {
    mock.clock(on)
    on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'Explain the loop. The event loop is…' } }] }) } }))
    let modelSaw = ''
    on('prompt.submit', ($, e) => ((modelSaw = e.text), { text: e.text }))
    await $.prompt.submit({ text: 'Объясни event loop', wait: false, origin: { kind: 'composer' } })
    expect(modelSaw).toBe('Объясни event loop')
  })

  test('claude -p: the mod stays out of the way', withService, async ($, on) => {
    const seen: Req[] = []
    fakeService(on, seen)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    let modelSaw = ''
    on('prompt.submit', ($, e) => ((modelSaw = e.text), { text: e.text }))
    await $.session.start({ ...sessionStart, isInteractive: false })
    await $.prompt.submit({ text: 'Привет, почини сборку', wait: false, origin: { kind: 'sdk' } })
    expect(modelSaw).toBe('Привет, почини сборку')
    expect(seen).toEqual([])
  })

  test('a reply chunk keeps its translated sentences when one fails; a retry asks only for that one', withService, async ($, on) => {
    const clock = mock.clock(on)
    const seen: string[] = []
    let healed = false
    on('http.fetch', async ($, e) => {
      const text = (JSON.parse(e.init?.body ?? '{}') as { messages: { content: { text: string }[] }[] }).messages[0]!.content[0]!.text.slice(1, -1)
      seen.push(text)
      // The whole chunk runs away; "Bad one." fails until the service heals.
      const out = text.includes('. ') ? `"RU ${text}" ${'x'.repeat(200)}` : text === 'Bad one.' && !healed ? 'an answer, not a translation: '.repeat(3) : `"RU ${text}"`
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: out } }] }) } }
    })
    drawText(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('prompt.submit', ($, e) => ({ text: e.text }))
    await $.session.start(sessionStart)
    await $.prompt.submit({ text: 'Привет', wait: false, origin: { kind: 'composer' } })
    const ui = await $.ui.mount({ plugin: 'lang-bridge', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Good one. Bad one.', isFirstOfReply: true } })
    await clock.advance(150)
    expect(await ui.find({ type: 'Text', text: '> ⚠️ *Фрагмент не переведён — показан оригинал*\n\nRU Good one. Bad one.\n\n*🌐 машинный перевод · `/lang original` — оригинал*' })).toBeDefined()
    healed = true
    seen.length = 0
    await clock.advance(30_000)
    await clock.advance(150)
    expect(seen).toEqual(['Good one. Bad one.', 'Bad one.'])
    expect(await ui.find({ type: 'Text', text: 'RU Good one. RU Bad one.\n\n*🌐 машинный перевод · `/lang original` — оригинал*' })).toBeDefined()
    await ui.unmount()
  })

  test('service down: the original prompt is sent', withService, async ($, on) => {
    mock.clock(on)
    on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
    let modelSaw = ''
    on('prompt.submit', ($, e) => ((modelSaw = e.text), { text: e.text }))
    await $.prompt.submit({ text: 'Привет, почини сборку', wait: false, origin: { kind: 'composer' } })
    expect(modelSaw).toBe('Привет, почини сборку')
  })

  test('a hung service times out and the original is sent', withService, async ($, on) => {
    const clock = mock.clock(on)
    on('http.fetch', () => new Promise(() => {}))
    let modelSaw = ''
    on('prompt.submit', ($, e) => ((modelSaw = e.text), { text: e.text }))
    const p = $.prompt.submit({ text: 'مرحبا، أصلح الاختبار', wait: false, origin: { kind: 'composer' } })
    await clock.advance(29_999)
    expect(modelSaw).toBe('')
    await clock.advance(1)
    await p
    expect(modelSaw).toBe('مرحبا، أصلح الاختبار')
  })

  test('system prompt gains a reply-in-English section', withService, async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }))
    const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(r.sections.map(s => s.id)).toEqual(['intro', 'lang-bridge:language'])
  })
})

// `/lang`: the test answers command.register beneath the plugin.
async function startWithLang($: Parameters<TestBody>[0], on: On) {
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  await $.session.start(sessionStart)
}
const lang = (args: string) => ({ command: 'lang', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

describe('/lang', () => {
  test('a pinned language draws every reply in it; auto goes back to the prompt language', withService, async ($, on) => {
    const status: (string | undefined)[] = []
    on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
    const clock = fakeService(on, [])
    drawText(on)
    await startWithLang($, on)
    await $.prompt.submit({ text: 'Привет, почини тест', wait: false, origin: { kind: 'composer' } })
    expect((await $.command.run(lang('es'))).text).toBe('🌐 replies: es')
    expect(status[status.length - 1]).toBe('🌐 LangMode ES⇄EN')
    const ui = await $.ui.mount({ plugin: 'lang-bridge', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Done.', isFirstOfReply: true } })
    await clock.advance(150)
    expect(await ui.find({ type: 'Text', text: '[es] Done.\n\n*🌐 traducción automática · `/lang original` — ver el original*' })).toBeDefined()
    await $.command.run(lang('auto'))
    expect(status[status.length - 1]).toBe('🌐 LangMode RU⇄EN')
    await clock.advance(150)
    expect(await ui.find({ type: 'Text', text: '[ru] Done.\n\n*🌐 машинный перевод · `/lang original` — оригинал*' })).toBeDefined()
    await ui.unmount()
  })

  test('direct: prompts go as typed, replies are not translated, the model is told to answer in the language of the user', withService, async ($, on) => {
    const seen: Req[] = []
    const got: string[] = []
    const status: (string | undefined)[] = []
    on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
    fakeService(on, seen)
    drawText(on)
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('prompt.submit', ($, e) => (got.push(e.text), { text: e.text }))
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start(sessionStart)
    await $.command.run(lang('direct'))
    expect(status[status.length - 1]).toBe('🌐 LangMode direct')
    await $.prompt.submit({ text: 'Привет, почини тест', wait: false, origin: { kind: 'composer' } })
    expect(got).toEqual(['Привет, почини тест'])
    const r = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(r.sections[0]!.text).toContain('Reply in the language the user writes in.')
    const ui = await $.ui.mount({ plugin: 'lang-bridge', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Готово.', isFirstOfReply: true } })
    expect(await ui.find({ type: 'Text', text: 'Готово.' })).toBeDefined()
    await ui.unmount()
    expect(seen).toEqual([])
    await $.command.run(lang('bridge'))
    await $.prompt.submit({ text: 'Привет, почини тест', wait: false, origin: { kind: 'composer' } })
    expect(got[1]).toBe('[en] Привет, почини тест')
    // A reply written in Russian under direct stays as it is back in bridge.
    const again = await $.ui.mount({ plugin: 'lang-bridge', surface: 'terminal', component: 'AssistantMessage', props: { text: 'Готово.', isFirstOfReply: true } })
    expect(await again.find({ type: 'Text', text: 'Готово.' })).toBeDefined()
    await again.unmount()
    expect(seen.filter(r => r.source === 'en')).toEqual([])
  })

  test('raw sends one prompt as typed', withService, async ($, on) => {
    const got: string[] = []
    fakeService(on, [])
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('prompt.submit', ($, e) => (got.push(e.text), { text: e.text }))
    await $.session.start(sessionStart)
    await $.command.run(lang('raw'))
    await $.prompt.submit({ text: 'Привет, почини тест', wait: false, origin: { kind: 'composer' } })
    await $.prompt.submit({ text: 'Привет, почини тест', wait: false, origin: { kind: 'composer' } })
    expect(got).toEqual(['Привет, почини тест', '[en] Привет, почини тест'])
  })

  test('original shows the last answer in English; retry translates it again', withService, async ($, on) => {
    const seen: Req[] = []
    const clock = fakeService(on, seen)
    drawText(on)
    on('turn.complete', ($, e) => ({ text: e.answer }))
    await startWithLang($, on)
    expect((await $.command.run(lang('original'))).text).toBe('🌐 no reply yet')
    await $.prompt.submit({ text: 'Привет', wait: false, origin: { kind: 'composer' } })
    const reply = 'Open `a.ts`.'
    const ui = await $.ui.mount({ plugin: 'lang-bridge', surface: 'terminal', component: 'AssistantMessage', props: { text: reply, isFirstOfReply: true } })
    await clock.advance(150)
    await $.turn.complete({ answer: reply, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    expect((await $.command.run(lang('original'))).text).toBe(reply)
    const before = seen.filter(r => r.target === 'ru').length
    expect((await $.command.run(lang('retry'))).text).toBe('🌐 translating the last reply again')
    await clock.advance(150)
    expect(seen.filter(r => r.target === 'ru').length).toBe(before + 1)
    expect(await ui.find({ type: 'Text', text: '[ru] Open `a.ts`.\n\n*🌐 машинный перевод · `/lang original` — оригинал*' })).toBeDefined()
    await ui.unmount()
  })

  test('reset clears the warning count', withService, async ($, on) => {
    const status: (string | undefined)[] = []
    on('ui.status', ($, e) => (status.push(e.text), { value: undefined }))
    mock.clock(on)
    on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
    await startWithLang($, on)
    await $.prompt.submit({ text: 'Привет, почини сборку', wait: false, origin: { kind: 'composer' } })
    expect(status[status.length - 1]).toBe('🌐 LangMode RU⇄EN ⚠ 1')
    await $.command.run(lang('reset'))
    expect(status[status.length - 1]).toBe('🌐 LangMode RU⇄EN')
  })
})
