// Pure helpers for translating markdown through TranslateGemma: chunking (fenced code
// and letterless blocks never reach the model), the literal check (the model keeps
// `inline code`, URLs and links by itself; a chunk that lost one stays in the
// original) and language detection. The calls through $ live in register.tsx: $ is
// never followed across an import.
export type Lang = 'en' | 'ru' | 'uk' | 'es' | 'ar'

// max-model-len is 4096 tokens for input and output together, so 3000 chars is the
// ceiling. Smaller chunks translate in parallel: one 2949-char chunk took 15.8 s,
// a 286-char one 2.4 s.
export const CHUNK_CHARS = 3000
// `sep` is what joins this unit to the previous one in the output.
export type Segment = { code: boolean; text: string; sep?: string }

// Split on blank lines without breaking fenced code blocks (same rules as the
// service's own web UI).
export function segments(md: string): Segment[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: Segment[] = []
  let buf: string[] = []
  let fence: string | null = null
  const flush = () => {
    if (buf.length) out.push({ code: false, text: buf.join('\n') })
    buf = []
  }
  for (const line of lines) {
    if (fence !== null) {
      buf.push(line)
      const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
      if (m?.[1] !== undefined && m[1][0] === fence[0] && m[1].length >= fence.length) {
        out.push({ code: true, text: buf.join('\n') })
        buf = []
        fence = null
      }
      continue
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (open?.[1] !== undefined) {
      flush()
      fence = open[1]
      buf.push(line)
      continue
    }
    if (line.trim() === '') {
      flush()
      continue
    }
    buf.push(line)
  }
  if (fence !== null) out.push({ code: true, text: buf.join('\n') })
  else flush()
  for (const s of out) if (!s.code && !/\p{L}/u.test(s.text)) s.code = true
  return out
}

// Neighbouring text segments joined into chunks of at most CHUNK_CHARS; code
// segments stay separate. A longer segment is cut by lines, a longer line by
// sentences (max-model-len is 4096 tokens).
export function chunks(md: string, limit = CHUNK_CHARS): Segment[] {
  const units: Segment[] = []
  let cur = ''
  const pushText = (t: string) => {
    if (t.length <= limit) return void units.push({ code: false, text: t })
    let b = ''
    let first = true
    const push = () => {
      units.push(first ? { code: false, text: b } : { code: false, text: b, sep: '\n' })
      first = false
      b = ''
    }
    for (const l of t.split('\n')) {
      if (l.length > limit) {
        if (b) push()
        let sep = '\n'
        for (const x of sentences(l)) {
          if (b && (b + x).length > limit) {
            units.push(first ? { code: false, text: b.trimEnd() } : { code: false, text: b.trimEnd(), sep })
            first = false
            sep = ' '
            b = ''
          }
          b += x
        }
        if (b) {
          units.push(first ? { code: false, text: b.trimEnd() } : { code: false, text: b.trimEnd(), sep })
          first = false
          b = ''
        }
        continue
      }
      if (b && (b + '\n' + l).length > limit) push()
      b = b ? b + '\n' + l : l
    }
    if (b) push()
  }
  for (const s of segments(md)) {
    if (s.code) {
      if (cur) pushText(cur)
      cur = ''
      units.push(s)
      continue
    }
    if (cur && (cur + '\n\n' + s.text).length > limit) {
      pushText(cur)
      cur = s.text
    } else cur = cur ? cur + '\n\n' + s.text : s.text
  }
  if (cur) pushText(cur)
  return units
}

// Sent in quotes, the text reads to TranslateGemma as something to translate,
// not something to answer ("Ответь одним предложением: что такое eslint?" came
// back as a definition of eslint; quoted, it comes back translated).
export const quote = (text: string) => `«${text}»`

// The translation without the quotes it came back in; undefined when they are
// missing, which means the model answered instead of translating. The outer
// pair is the wrapper only when it adds to the source's own quotes; the model
// often turns «» into "" and sometimes drops the wrapper around a text that
// starts or ends with a quote of its own (`"Сессия истекла" — найди…`) or
// with markdown structure.
// Quote marks, single ones too (the model turns «» into ''), but not the
// apostrophe inside a word (don't).
const QUOTES = /[«»"“”„‘]|(?<!\p{L})['’]|['’](?!\p{L})/gu
const count = (t: string) => (t.match(QUOTES) ?? []).length
export function unquote(out: string, source: string): string | undefined {
  const o = out.trim()
  const s = source.trim()
  const m = /^([«"“„'‘])([\s\S]*)([»"”'’])$/.exec(o)
  if (m !== null) {
    if (count(o) >= count(s) + 2) {
      // Sometimes wrapped twice, with the source's «» turned into '' inside
      // ("«срок истёк»" came back as `""Translate: 'The session expired.'""`).
      const t = m[2]!.trim()
      const twice = /^"([\s\S]*)"$/.exec(t)
      return twice !== null && !(/^[«"“„]/.test(s) && /[»"”]$/.test(s)) && !/"/.test(twice[1]!) ? twice[1]!.trim() : t
    }
  }
  const opens = (t: string) => /^[«"“„]/.test(t)
  const closes = (t: string) => /[»"”]$/.test(t)
  if (count(s) > 0 && count(o) === count(s) && ((opens(s) && opens(o)) || (closes(s) && closes(o)))) return o
  // Text that starts with markdown structure (`## Summary`, a list, a table)
  // tends to come back unwrapped, or with only the closing quote. An answer
  // does not start with the same heading or list as the text it answers.
  const block = (t: string) => /^(#{1,6} |[-*+] |\d+[.)] |> |\|)/.exec(t)?.[1]
  const b = block(s)
  if (b !== undefined && block(o)?.replace(/\d+/, '1') === b.replace(/\d+/, '1')) {
    return closes(o) && count(o) === count(s) + 1 ? o.slice(0, -1).trimEnd() : o
  }
  return undefined
}

// TranslateGemma sometimes answers an imperative prompt instead of translating
// it ("write a debounce function" came back as the function). A translation far
// longer than its source is such an answer.
export function runaway(source: string, translated: string): boolean {
  return translated.length > source.length * 2 + 60
}

// A text cut after each sentence and line, so a chunk that ran away can be
// translated piece by piece. Inline code is never cut. Joining the pieces gives
// the text back.
export function sentences(text: string): string[] {
  const out: string[] = []
  let start = 0
  const re = /`[^`\n]*`|[.!?…](?=\s)\s*|\n+/g
  for (const m of text.matchAll(re)) {
    if (m[0].startsWith('`')) continue
    const end = m.index! + m[0].length
    if (text.slice(start, end).trim() !== '') {
      out.push(text.slice(start, end))
      start = end
    }
  }
  if (start < text.length) {
    if (out.length > 0 && text.slice(start).trim() === '') out[out.length - 1] += text.slice(start)
    else out.push(text.slice(start))
  }
  return out
}

// What must survive translation byte for byte.
export function literals(text: string): string[] {
  const found = [
    ...text.matchAll(/`[^`\n]+`/g),
    ...text.matchAll(/\bhttps?:\/\/[^\s)>\]]*[^\s)>\].,;:!?'"»]/g),
    ...text.matchAll(/\]\(([^)\s]+)\)/g),
  ].map(m => m[0])
  return found.sort()
}

export function keepsLiterals(source: string, translated: string): boolean {
  // Each distinct literal must survive; the model may merge a repeated one
  // ("`fn` … `fn`" -> one `fn`), which loses nothing.
  const got = new Set(literals(translated))
  return literals(source).every(w => got.has(w))
}

// The model sometimes edits inside backticks (`npm test -- session` came back as
// `npm test --session`). When source and translation hold the same number of
// inline code spans, put the source's bytes back in order. The caller still runs
// keepsLiterals on the result.
export function repairInlineCode(source: string, translated: string): string {
  const want = [...source.matchAll(/`[^`\n]+`/g)].map(m => m[0])
  let i = 0
  const got = translated.match(/`[^`\n]+`/g) ?? []
  if (got.length === want.length) return translated.replace(/`[^`\n]+`/g, () => want[i++]!)
  // The model also drops the backticks (`session.test.js` came back as
  // "session.test.js"): a span missing from the translation is put back around
  // its first quoted or bare occurrence outside other spans.
  let out = translated
  for (const w of want) {
    if (out.includes(w)) continue
    const inner = w.slice(1, -1)
    const esc = inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(\`[^\`\\n]*\`)|["«“']${esc}["»”']|${esc}`, 'g')
    const m = [...out.matchAll(re)].find(x => x[1] === undefined)
    if (m === undefined) continue
    out = out.slice(0, m.index) + w + out.slice(m.index + m[0].length)
  }
  return out
}

const stripCode =(t: string) =>
  segments(t)
    .filter(s => !s.code)
    .map(s => s.text.replace(/`[^`\n]*`/g, ' ').replace(/\bhttps?:\/\/\S+/g, ' '))
    .join('\n')

// Language of a prompt from its prose (code, paths and URLs left out).
// Latin-script text is Spanish only with clear Spanish marks; otherwise English.
export function detect(text: string): Lang {
  const t = stripCode(text)
  const letters = (t.match(/\p{L}/gu) ?? []).length
  if (letters === 0) return 'en'
  const ar = (t.match(/[؀-ۿݐ-ݿ]/g) ?? []).length
  const cyr = (t.match(/[Ѐ-ӿ]/g) ?? []).length
  if (ar / letters > 0.3) return 'ar'
  if (cyr / letters > 0.3) return /[іїєґІЇЄҐ]/.test(t) ? 'uk' : 'ru'
  if (/[ñ¿¡]/i.test(t)) return 'es'
  const words = t.toLowerCase().match(/\p{L}+/gu) ?? []
  const es = new Set(['el', 'la', 'los', 'las', 'que', 'de', 'y', 'en', 'por', 'para', 'con', 'una', 'un', 'es', 'no', 'del', 'al', 'lo', 'como', 'pero', 'sí', 'esto', 'este', 'archivo', 'cambia', 'cambies', 'haz', 'arregla', 'añade'])
  const en = new Set(['the', 'and', 'of', 'to', 'in', 'is', 'it', 'for', 'with', 'this', 'that', 'on', 'a', 'an', 'fix', 'add', 'run', 'please', 'file'])
  let s = 0
  let e = 0
  for (const w of words) {
    if (es.has(w)) s++
    if (en.has(w)) e++
  }
  if (/[áéíóú]/i.test(t) && s >= e) return 'es'
  return s > e && s >= 2 ? 'es' : 'en'
}
