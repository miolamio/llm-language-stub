# lang-bridge (LangMode)

A Claude Code mod for working in your own language. You type in Russian,
Ukrainian, Spanish or Arabic; the prompt is machine-translated to English before
the model reads it, and the model's English replies are drawn translated back
into your language. Code, paths, identifiers, inline code, URLs and link targets
are kept exactly as written, and fenced code blocks are never sent for
translation.

The original English reply is always one command away, and the status line
shows the active language pair, translation in progress, and any problems.

## How it works

- **Prompts** are detected by language. Non-English prompts are translated to
  English; the transcript row still shows what you typed. English prompts and
  slash commands pass through untouched.
- **Replies** show a pending mark while translating, then the translation with a
  short machine-translation footer. Each reply keeps the language it was drawn
  in, even after you switch languages.
- **Failures never lose a turn.** If the service is down, times out, or answers
  instead of translating, the original text is sent or shown and the
  untranslated part is marked.
- In headless runs (`claude -p`) the mod stays out of the way.

## Requirements

An OpenAI-compatible `chat/completions` endpoint serving a translation model
(built and tested against `translategemma-12b`, e.g. on vLLM).

## Install

```sh
claude --plugin-dir /path/to/langmode
# or, from this checkout:
./bin/claude-lang        # LANGMODE_DEBUG=1 writes a debug log
```

## Configuration

Set in the `/config` menu or under `pluginConfigs["lang-bridge"]` in settings:

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | empty (off) | Translation service, e.g. `http://localhost:8000/v1/chat/completions`. **Required**: empty turns the mod off. |
| `lang` | `auto` | Reply language: `auto` follows your last prompt, or a fixed `ru`, `uk`, `es`, `ar`, `en`. |
| `timeoutSec` | `30` | Per-chunk timeout; a chunk not translated in time is shown or sent in the original. |

## The `/lang` command

| Command | Effect |
| --- | --- |
| `/lang` or `/lang status` | Mode, reply language, problem count, service URL. |
| `/lang ru` · `uk` · `es` · `ar` · `en` | Pin replies to one language. |
| `/lang auto` | Replies follow the language of the last prompt. |
| `/lang direct` | No translation: prompts go as typed and the model is told to answer in your language. |
| `/lang bridge` | Back to translating both ways (the default). |
| `/lang raw` | Send the next prompt as typed, once. |
| `/lang original` | Show the last reply in English. |
| `/lang retry` | Translate the last reply again. |
| `/lang reset` | Clear the problem counter. |

## Development

```sh
claude plugin validate .
claude plugin test .
```

## License

MIT, see [LICENSE](LICENSE).
