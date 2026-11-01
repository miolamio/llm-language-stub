# llm-language-stub

Work with Claude Code in your own language.

Coding agents reason best in English, and their docs, code and tooling are in
English. This repository holds **LangMode** (`lang-bridge`), a Claude Code mod
that sits between you and the model:

```
you type (RU / UK / ES / AR)  ──►  translated to English  ──►  model
you read (your language)      ◄──  translated back        ◄──  model replies in English
```

- **Prompts** in Russian, Ukrainian, Spanish or Arabic are translated to English
  before the model reads them. The transcript still shows what you typed.
  English prompts and slash commands pass through untouched.
- **Replies** are shown translated back into your language, with a short
  machine-translation note. The English original is one `/lang original` away.
- **Code stays exact.** Fenced code blocks are never sent for translation;
  inline code, paths, identifiers, URLs and link targets are checked and put
  back if the translator changed them.
- **Nothing is lost on failure.** If the translation service is down, slow, or
  answers instead of translating, the original text is sent or shown and the
  untranslated part is marked.
- **`/lang`** pins the reply language, switches to `direct` mode (no
  translation, the model just answers in your language), sends one prompt raw,
  or retranslates the last reply.

Translation is done by a model you host: any OpenAI-compatible
`chat/completions` endpoint serving a translation model (built and tested
against `translategemma-12b`). No service is configured by default.

## Quick start

```sh
git clone https://github.com/miolamio/llm-language-stub.git
cd llm-language-stub
claude --plugin-dir ./langmode
```

Then set the translation service URL in `/config` (or under
`pluginConfigs["lang-bridge"]` in `~/.claude/settings.json`). Until a URL is
set, the mod stays off.

Full options and every `/lang` command: [langmode/README.md](langmode/README.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `langmode/hooks/register.tsx` | The mod: prompt, reply, system-prompt and `/lang` hooks |
| `langmode/hooks/translate.ts` | Language detection, chunking, code-preserving translation |
| `langmode/tests/` | Tests, run with `claude plugin test langmode` |
| `langmode/bin/claude-lang` | Launcher: Claude Code with the mod loaded from this checkout |

## License

MIT, see [langmode/LICENSE](langmode/LICENSE).
