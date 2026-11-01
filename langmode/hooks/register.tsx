import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { chunks, detect, keepsLiterals, quote, repairInlineCode, runaway, sentences, unquote } from './translate'
import type { Lang } from './translate'

const MODEL = 'translategemma-12b'
// Chunks of one message translated at once.
const MAX_PARALLEL = 6
// Chunk size for replies: small, so a long reply translates in parallel.
const DISPLAY_CHUNK_CHARS = 700

// `temperature` above 0 on retries: at 0 the service repeats its failure exactly.
type Config = { url: string; timeoutMs: number; temperature?: number }
// `failed` counts prose chunks left in the original.
// `failed`: prose chunks with something left in the original; `untouched`: of
// them, those not translated at all; `prose`: all prose chunks.
type Result = { text: string; complete: boolean; failed: number; untouched: number; prose: number }

// The service answered the text instead of translating it.
const RUNAWAY = Symbol('runaway')

async function callService($: EngineInterface, c: Config, text: string, source: Lang, target: Lang): Promise<string | typeof RUNAWAY | undefined> {
  const body = JSON.stringify({
    model: MODEL,
    temperature: c.temperature ?? 0,
    stream: false,
    // A translation is about as long as its source; the cap stops the model
    // early when it starts answering the text instead (see runaway()).
    max_tokens: Math.min(2048, Math.ceil(text.length * 0.75) + 36),
    messages: [{ role: 'user', content: [{ type: 'text', source_lang_code: source, target_lang_code: target, text: quote(text) }] }],
  })
  const t0 = await $.clock.now()
  try {
    // $.http.fetch has no timeout or abort: race the clock.
    const r = await Promise.race([
      $.http.fetch(c.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body }),
      $.clock.sleep(c.timeoutMs).then(() => undefined),
    ])
    const ms = (await $.clock.now()) - t0
    if (r === undefined || !r.ok) {
      $.ui.log(`lang-bridge: http ${source}->${target} ${text.length}ch ${r === undefined ? 'TIMEOUT' : `HTTP ${r.status}`} ${ms}ms`, { to: 'debug' })
      return undefined
    }
    const j = JSON.parse(r.text) as { choices?: { finish_reason?: string; message?: { content?: string } }[] }
    const said = j.choices?.[0]?.message?.content?.trim()
    let out = said === undefined ? undefined : unquote(said, text)
    const cut = j.choices?.[0]?.finish_reason === 'length'
    $.ui.log(`lang-bridge: http ${source}->${target} ${text.length}ch -> ${out?.length ?? 0}ch${cut ? ' CUT' : ''} ${ms}ms`, { to: 'debug' })
    if (said === undefined || said === '') return undefined
    // In replies the quotes also go missing around plain translations (a chunk
    // starting with `(` or inline code): one of about the source's length is
    // taken. Not for prompts, where an answer reaching the model does harm and
    // a short answer to a short question can be as long as the question.
    if (out === undefined && !cut && source === 'en' && said.length >= text.length * 0.5 && said.length <= text.length * 1.6 + 10) {
      $.ui.log(`lang-bridge: unquoted, taken by length`, { to: 'debug' })
      out = said
    }
    if (out === undefined) $.ui.log(`lang-bridge: answer without quotes, not a translation: ${JSON.stringify(said.slice(0, 200))}`, { to: 'debug' })
    return out === undefined || cut || runaway(text, out) ? RUNAWAY : out
  } catch (err) {
    // Esc while translating: the turn is cancelled, not the service down.
    if (String(err).includes('user-cancel')) throw err
    $.ui.log(`lang-bridge: http ${source}->${target} ERROR ${String(err)}`, { to: 'debug' })
    return undefined
  }
}

// Translated chunks and sentences, so a retry or a redraw asks only for what failed.
const memo = new Map<string, string>()

// One prose chunk: whole, or sentence by sentence when the whole ran away.
// undefined when nothing was translated; `ok: false` when some sentences were
// left in the original.
async function translateProse($: EngineInterface, c: Config, text: string, source: Lang, target: Lang): Promise<{ text: string; ok: boolean } | undefined> {
  const check = (src: string, raw: string) => {
    const t = repairInlineCode(src, raw)
    if (keepsLiterals(src, t)) return t
    $.ui.log(`lang-bridge: literal check failed, chunk kept in original: ${JSON.stringify(t.slice(0, 200))}`, { to: 'debug' })
    return undefined
  }
  const one = async (src: string) => {
    const key = `${source}>${target}\0${src}`
    const hit = memo.get(key)
    if (hit !== undefined) return hit
    const r = await callService($, c, src, source, target)
    const t = r === undefined ? undefined : r === RUNAWAY ? RUNAWAY : check(src, r)
    if (typeof t === 'string') memo.set(key, t)
    return t
  }
  // A reply of "OK", "v2", "+1": nothing to translate, and the model makes up
  // an answer. A prompt of "Да" still goes: the model is to read English.
  if (source === 'en' && text.replace(/[^\p{L}]/gu, '').length < 3) return { text, ok: true }
  const whole = await one(text)
  if (typeof whole === 'string') return { text: whole, ok: true }
  if (whole === undefined) return undefined
  const parts = sentences(text)
  $.ui.log(`lang-bridge: runaway translation, retrying ${parts.length} sentence(s)`, { to: 'debug' })
  if (parts.length < 2) return undefined
  const out = await Promise.all(
    parts.map(async p => {
      const t = await one(p.trim())
      return typeof t === 'string' ? { text: p.match(/^\s*/)![0] + t + p.match(/\s*$/)![0], ok: true } : { text: p, ok: false }
    }),
  )
  if (out.every(x => !x.ok)) return undefined
  return { text: out.map(x => x.text).join(''), ok: out.every(x => x.ok) }
}

// Translates a markdown message chunk by chunk; code goes through untouched.
// `complete` is false when any chunk stayed in the original (service down,
// timeout or a lost literal).
// `mark` prefixes each chunk left in the original with a visible line.
async function translateMarkdown($: EngineInterface, c: Config, md: string, source: Lang, target: Lang, limit?: number, mark?: string): Promise<Result> {
  if (source === target) return { text: md, complete: true, failed: 0, untouched: 0, prose: 0 }
  const units = chunks(md, limit)
  const out = new Array<string>(units.length)
  let failed = 0
  let untouched = 0
  let next = 0
  const worker = async () => {
    while (next < units.length) {
      const i = next++
      const u = units[i]!
      if (u.code) {
        out[i] = u.text
        continue
      }
      const t = await translateProse($, c, u.text, source, target)
      if (t?.ok === true) out[i] = t.text
      else if (t !== undefined && mark !== undefined) {
        // Some sentences translated: kept, under the mark.
        out[i] = `${mark}\n\n${t.text}`
        failed++
      } else {
        out[i] = mark === undefined ? u.text : `${mark}\n\n${u.text}`
        failed++
        untouched++
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, units.length) }, worker))
  const text = out.map((t, i) => (i === 0 ? t : (units[i]!.sep ?? '\n\n') + t)).join('')
  return { text, complete: failed === 0, failed, untouched, prose: units.filter(u => !u.code).length }
}

const originals = { plugin: 'lang-bridge', key: 'originals' } as const
const displayLang = { plugin: 'lang-bridge', key: 'displayLang' } as const
const unsent = { plugin: 'lang-bridge', key: 'unsent' } as const
const pinKey = { plugin: 'lang-bridge', key: 'pin' } as const
const modeKey = { plugin: 'lang-bridge', key: 'mode' } as const
const lastReply = { plugin: 'lang-bridge', key: 'lastReply' } as const

const LANGS: readonly Lang[] = ['en', 'ru', 'uk', 'es', 'ar']
const LANG_NAMES: Record<Lang, string> = { en: 'English', ru: 'Russian', uk: 'Ukrainian', es: 'Spanish', ar: 'Arabic' }

// What the person sees, in the language of the reply.
const LABELS: Record<Lang, { footer: string; pending: string; untranslated: string; unsent: string }> = {
  en: { footer: '', pending: '', untranslated: '', unsent: '' },
  ru: {
    footer: '*🌐 машинный перевод · `/lang original` — оригинал*',
    pending: '*🌐 ⏳ перевожу…*',
    untranslated: '> ⚠️ *Фрагмент не переведён — показан оригинал*',
    unsent: '⚠️ 🌐 отправлено без перевода',
  },
  uk: {
    footer: '*🌐 машинний переклад · `/lang original` — оригінал*',
    pending: '*🌐 ⏳ перекладаю…*',
    untranslated: '> ⚠️ *Фрагмент не перекладено — показано оригінал*',
    unsent: '⚠️ 🌐 надіслано без перекладу',
  },
  es: {
    footer: '*🌐 traducción automática · `/lang original` — ver el original*',
    pending: '*🌐 ⏳ traduciendo…*',
    untranslated: '> ⚠️ *Fragmento sin traducir — se muestra el original*',
    unsent: '⚠️ 🌐 enviado sin traducir',
  },
  ar: {
    footer: '*🌐 ترجمة آلية · `/lang original` — النص الأصلي*',
    pending: '*🌐 ⏳ جارٍ الترجمة…*',
    untranslated: '> ⚠️ *لم تتم ترجمة هذا الجزء — يُعرض الأصل*',
    unsent: '⚠️ 🌐 أُرسل دون ترجمة',
  },
}

// The status line: always on while the mod is, so it is not forgotten.
// `🌐 LangMode RU⇄EN`, `🌐 LangMode RU⇄EN ⏳` while translating, `⚠ N` once something stayed untranslated.
let inFlight = 0
let problems = 0
let statusLang: Lang | 'auto' = 'auto'
let headless = false
// `/lang direct`: mirrors the `mode` state for the status line.
let direct = false
// `/lang raw`: the next prompt goes as typed.
let raw = false
function showStatus($: EngineInterface) {
  const pair = direct ? 'direct' : statusLang === 'en' ? 'EN' : `${statusLang === 'auto' ? 'auto' : statusLang.toUpperCase()}⇄EN`
  const spin = inFlight > 0 ? ' ⏳' : ''
  const warn = problems > 0 ? ` ⚠ ${problems}` : ''
  $.ui.status(`🌐 LangMode ${pair}${raw ? ' · raw' : ''}${spin}${warn}`)
}
async function whileBusy<T>($: EngineInterface, work: Promise<T>): Promise<T> {
  inFlight++
  showStatus($)
  try {
    return await work
  } finally {
    inFlight--
    showStatus($)
  }
}

// Reply translations are background work. A render hook may not wait on the network:
// a redraw supersedes its dispatch and aborts every $ call it made ("ui.render:
// superseded"). So a render draws what is in state, and queues what is missing; a
// worker started from session.start runs the queue and writes the result to state,
// which redraws the rows that read it.
const translations = { plugin: 'lang-bridge', key: 'translations' } as const
type Job = { text: string; lang: Lang; footer: boolean }
const queued = new Map<string, Job>()
const running = new Set<string>()
// English reply block -> the language it was first drawn in.
const bound = new Map<string, Lang>()

// `footer`: a whole reply block gets the machine-translation mark; short strings
// (question text, option descriptions) do not.
const keyOf = (j: Job) => `${j.lang}\0${j.footer ? 1 : 0}\0${j.text}`

// The translation if it is ready; otherwise queues it and answers undefined.
// A result with chunks left in the original is drawn as is; `!key` in the table
// holds the attempts made, so a reload, which forgets `retries`, goes on with
// the attempts left instead of starting over.
function ready(table: Record<string, string> | undefined, job: Job): string | undefined {
  const k = keyOf(job)
  const hit = table?.[k]
  const tried = table?.[`!${k}`]
  const again = hit !== undefined && tried !== undefined && !retries.has(k) && Number(tried) <= RETRIES
  if ((hit === undefined || again) && !running.has(k)) {
    if (again) retries.set(k, Number(tried))
    queued.set(k, job)
  }
  return hit
}

// A reply left (partly) untranslated is tried again after 30 s, 60 s, 90 s.
const RETRIES = 3
const RETRY_MS = 30_000
const retries = new Map<string, number>()
// `/lang retry`: translations asked for again by the person.
const fresh = new Set<string>()

async function runJob($: EngineInterface, c: Config, k: string, job: Job) {
  const l = LABELS[job.lang]
  try {
    const again = retries.has(k) || fresh.has(k)
    const cc = again ? { ...c, temperature: 0.4 } : c
    const r = await whileBusy($, translateMarkdown($, cc, job.text, 'en', job.lang, DISPLAY_CHUNK_CHARS, job.footer ? l.untranslated : undefined))
    // Retries of the same reply do not count or warn again.
    if (!r.complete && !again) {
      problems += r.failed
      showStatus($)
      $.ui.toast(`🌐 ⚠ ${r.failed} — ${l.untranslated.replace(/^> ⚠️ \*|\*$/g, '')}`)
    }
    // A partial result is kept too: its untranslated chunks carry the visible mark.
    // The footer only goes under something that was translated.
    const some = r.untouched < r.prose
    const text = job.footer && some ? `${r.text}\n\n${l.footer}` : job.footer || r.complete ? r.text : job.text
    const n = (retries.get(k) ?? 0) + 1
    await update($, translations, m => {
      const { [`!${k}`]: _, ...rest } = m ?? {}
      return r.complete ? { ...rest, [k]: text } : { ...rest, [k]: text, [`!${k}`]: String(n) }
    })
    // The service may be back later: try again a few times.
    if (!r.complete && n <= RETRIES) {
      retries.set(k, n)
      $.clock.after(RETRY_MS * n, () => {
        if (!running.has(k)) queued.set(k, job)
      })
    }
  } catch (err) {
    $.ui.log(`lang-bridge: reply translation ERROR ${String(err)}`, { to: 'debug' })
  } finally {
    running.delete(k)
    fresh.delete(k)
  }
}

// The `lang` setting, when it names a language.
let optLang: Lang | undefined
// The language replies are drawn in whatever the prompt: `/lang <code>`, else settings.
// Read from state, so a render that asks redraws when `/lang` changes it.
async function pinOf($: EngineInterface): Promise<Lang | undefined> {
  const { value } = await $.state.get(pinKey)
  return value === undefined ? optLang : value === 'auto' ? undefined : value
}
async function isDirect($: EngineInterface): Promise<boolean> {
  return (await $.state.get(modeKey)).value === 'direct'
}

const LANG_HELP = [
  '`/lang` — status',
  '`/lang auto|ru|uk|es|ar|en` — language replies are drawn in (auto: of the last prompt)',
  '`/lang bridge` — translate (default) · `/lang direct` — no translation, the model answers in your language',
  '`/lang raw` — send the next prompt as typed',
  '`/lang original` — the last reply in English',
  '`/lang retry` — translate the last reply again',
  '`/lang reset` — clear the ⚠ counter',
].join('\n')

export const register: Register = (on, options) => {
  const fixed = String(options.lang ?? 'auto')
  const c: Config = {
    url: String(options.url ?? ''),
    timeoutMs: Number(options.timeoutSec ?? 30) * 1000,
  }
  optLang = (LANGS as readonly string[]).includes(fixed) ? (fixed as Lang) : undefined

  // 0. The status line says the mod is on from the first frame.
  //    It also starts the worker that translates replies queued by the render hooks.
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // `claude -p`: nothing draws the reply, so it could not be translated back;
    // the mod stays out and the model answers in the language it was asked in.
    headless = !e.isInteractive
    if (headless) return r
    if (c.url === '') {
      $.ui.status('🌐 LangMode off: no translation service url')
      return r
    }
    if (fixed !== 'auto' && optLang === undefined) $.ui.toast(`🌐 LangMode: unknown language "${fixed}", using auto`)
    {
      // After a reload the language of the last prompt is still in state.
      const { value: last } = await $.state.get(displayLang)
      const pin = await pinOf($)
      statusLang = pin ?? last ?? 'auto'
      direct = await isDirect($)
      showStatus($)
      $.ui.toast(`🌐 LangMode on · ${direct ? 'direct' : pin === 'en' ? 'EN' : `${pin ? pin.toUpperCase() : 'auto'}⇄EN`}`)
      $.clock.every(150, () => {
        for (const [k, job] of queued) {
          queued.delete(k)
          running.add(k)
          void runJob($, c, k, job)
        }
      })
      // Last: a failure here leaves the worker running.
      try {
        await $.command.register({
          name: 'lang',
          description: 'LangMode: language, direct/bridge, raw, original, retry, reset',
          argumentHint: '[auto|ru|uk|es|ar|en|direct|bridge|raw|original|retry|reset]',
        })
      } catch (err) {
        $.ui.log(`lang-bridge: /lang not registered: ${String(err)}`, { to: 'debug' })
      }
    }
    return r
  })

  // 1. Inbound: the model reads English. The language of the prompt becomes the
  //    language replies are drawn in (unless fixed in settings).
  on('prompt.submit', async ($, e, next) => {
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (headless || !isPerson || e.text.trimStart().startsWith('/') || c.url === '') return next(e)
    if (await isDirect($)) return next(e)
    const source = detect(e.text)
    $.ui.log(`lang-bridge: prompt.submit detected=${source} ${e.text.length}ch raw=${raw}`, { to: 'debug' })
    const pin = await pinOf($)
    await update($, displayLang, () => source)
    statusLang = pin ?? source
    const once = raw
    raw = false
    showStatus($)
    if (source === 'en' || once) return next(e)
    let r: Result
    try {
      r = await whileBusy($, translateMarkdown($, c, e.text, source, 'en'))
    } catch (err) {
      // Esc while translating: the engine cancels the turn and puts the prompt
      // back in the input; nothing failed, so no mark.
      if (String(err).includes('user-cancel')) return next(e)
      throw err
    }
    if (!r.complete) {
      // The model reads the original language too; sending it beats losing the turn.
      problems++
      showStatus($)
      $.ui.toast(LABELS[source].unsent)
      await update($, unsent, m => ({ ...(m ?? {}), [e.text]: true as const }))
      return next(e)
    }
    await update($, originals, m => ({ ...(m ?? {}), [r.text]: e.text }))
    return next({ ...e, text: r.text })
  })

  // 2. The model answers in English whatever the person writes.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (headless || c.url === '') return r
    if (await isDirect($)) {
      const pin = await pinOf($)
      return {
        sections: [
          ...r.sections,
          {
            id: 'lang-bridge:language',
            scope: 'session',
            text:
              (pin === undefined ? 'Reply in the language the user writes in.' : `Reply in ${LANG_NAMES[pin]}.`) +
              ' Keep code, paths, identifiers, commands and exact strings unchanged, in backticks or fenced blocks.',
          },
        ],
      }
    }
    return {
      sections: [
        ...r.sections,
        {
          id: 'lang-bridge:language',
          scope: 'session',
          text:
            'A translation layer sits between you and the user: their messages reach you translated ' +
            'into English and your replies are machine-translated into their language. Always reply ' +
            'in English, even if a message is not in English. Put code, paths, identifiers, commands ' +
            'and exact strings in backticks or fenced blocks so they survive translation. If the user ' +
            'asks for an artifact (a file, an email, UI text) in a specific language, write that ' +
            'artifact in that language.',
        },
      ],
    }
  })

  // 3. The prompt row shows what the person typed, not the English.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const { value } = await $.state.get(originals)
    const original = value?.[e.props.text]
    if (original !== undefined) return next({ ...e, props: { ...e.props, text: `${original}\n\n🌐 → EN` } })
    const { value: failed } = await $.state.get(unsent)
    if (failed?.[e.props.text] === true) {
      const l = LABELS[detect(e.props.text)]
      return next({ ...e, props: { ...e.props, text: `${e.props.text}\n\n${l.unsent}` } })
    }
    return next(e)
  })

  // 4. Each assistant text block is drawn translated; the stored message, which the
  //    model reads next turn, stays English (ctrl+o shows it).
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (c.url === '' || e.props.text.trim() === '') return next(e)
    // Written in the person's language already (`/lang direct`, or the model
    // ignoring the policy): nothing to translate, whatever the mode is now.
    if (detect(e.props.text) !== 'en') return next(e)
    // A reply keeps the language of the turn that produced it: bound on its first
    // draw, so a later prompt in another language does not redraw old replies.
    // A module variable: drawing may not write state, and a reload starts it over.
    let target = (await pinOf($)) ?? bound.get(e.props.text)
    if (target === undefined) {
      const { value: lang } = await $.state.get(displayLang)
      target = lang ?? 'en'
      bound.set(e.props.text, target)
    }
    if (target === 'en') return next(e)
    const { value: table } = await $.state.get(translations)
    const job = { text: e.props.text, lang: target, footer: true }
    // Direct mode translates nothing new; replies translated before stay translated.
    if (await isDirect($)) {
      const done = table?.[keyOf(job)]
      return done === undefined ? next(e) : next({ ...e, props: { ...e.props, text: done } })
    }
    const t = ready(table, job)
    $.ui.log(`lang-bridge: render AssistantMessage ${e.props.text.length}ch target=${target} ready=${t !== undefined}`, { to: 'debug' })
    const text = t ?? `${e.props.text}\n\n${LABELS[target].pending}`
    return next({ ...e, props: { ...e.props, text } })
  })

  // 5. AskUserQuestion: the question and option descriptions are drawn translated.
  //    Option labels stay English: the chosen label is what goes back to the model.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    if (c.url === '' || (await isDirect($))) return next(e)
    const { value: lang } = await $.state.get(displayLang)
    const target = (await pinOf($)) ?? lang ?? 'en'
    if (target === 'en') return next(e)
    const { value: table } = await $.state.get(translations)
    const tr = (s: string | undefined) => (s === undefined ? s : (ready(table, { text: s, lang: target, footer: false }) ?? `${s} ⏳`))
    const qs = e.props.questions.map(q => {
      if (typeof q !== 'object' || q === null) return q
      const r = q as { question?: string; options?: { label: string; description?: string }[] }
      return {
        ...r,
        question: tr(r.question),
        options: r.options === undefined ? r.options : r.options.map(op => ({ ...op, description: tr(op.description) })),
      }
    })
    return next({ ...e, props: { ...e.props, questions: qs } })
  })

  // 6. The main loop's last answer, for `/lang original` and `/lang retry`.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && e.answer.trim() !== '') await update($, lastReply, () => e.answer)
    return next(e)
  })

  // 7. `/lang`: see LANG_HELP.
  on('command.run', { command: 'lang' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '' || arg === 'status') {
      const pin = await pinOf($)
      const { value: last } = await $.state.get(displayLang)
      const lines = [
        `🌐 LangMode · mode: ${direct ? 'direct' : 'bridge'} · replies: ${pin ?? `auto (${last ?? '—'})`}${raw ? ' · next prompt raw' : ''}`,
        `⚠ ${problems} · service: ${c.url === '' ? 'off' : c.url}`,
        '',
        LANG_HELP,
      ]
      return { text: lines.join('\n') }
    }
    if (arg === 'auto' || (LANGS as readonly string[]).includes(arg)) {
      const pin = arg as Lang | 'auto'
      await update($, pinKey, () => pin)
      const { value: last } = await $.state.get(displayLang)
      statusLang = pin === 'auto' ? (last ?? 'auto') : pin
      showStatus($)
      return { text: `🌐 replies: ${pin === 'auto' ? 'language of the last prompt' : pin}` }
    }
    if (arg === 'direct' || arg === 'bridge') {
      await update($, modeKey, () => arg)
      direct = arg === 'direct'
      showStatus($)
      return {
        text: direct
          ? '🌐 direct: prompts go as typed, the model answers in your language'
          : '🌐 bridge: prompts are translated to English, replies back',
      }
    }
    if (arg === 'raw') {
      raw = true
      showStatus($)
      return { text: '🌐 the next prompt goes as typed' }
    }
    if (arg === 'reset') {
      problems = 0
      showStatus($)
      return { text: '🌐 ⚠ counter cleared' }
    }
    if (arg === 'original' || arg === 'retry') {
      const { value: text } = await $.state.get(lastReply)
      if (text === undefined) return { text: '🌐 no reply yet' }
      if (arg === 'original') return { text }
      // Drop the reply's translations, and its chunks from the cache; the rows
      // reading the table redraw and queue it again.
      for (const k of memo.keys()) if (text.includes(k.slice(k.indexOf('\0') + 1))) memo.delete(k)
      let found = 0
      await update($, translations, m => {
        const out: Record<string, string> = {}
        for (const [k, v] of Object.entries(m ?? {})) {
          const key = k.startsWith('!') ? k.slice(1) : k
          if (key.endsWith(`\0${text}`)) {
            if (!k.startsWith('!')) {
              found++
              fresh.add(key)
              retries.delete(key)
            }
          } else out[k] = v
        }
        return out
      })
      return { text: found > 0 ? '🌐 translating the last reply again' : '🌐 the last reply has no translation to redo' }
    }
    return { text: `🌐 unknown: \`${arg}\`\n\n${LANG_HELP}` }
  })
}
