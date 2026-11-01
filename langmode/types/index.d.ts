export type LangBridgeOriginals = Record<string, string>
export type LangBridgeLang = 'en' | 'ru' | 'uk' | 'es' | 'ar'

declare module 'claude-code' {
  interface PluginState {
    'lang-bridge': {
      /** English text the model received -> what the person typed. */
      originals: LangBridgeOriginals
      /** Language of the last prompt: replies are drawn in it. */
      displayLang: LangBridgeLang
      /** Prompts sent in the original because translation failed. */
      unsent: Record<string, true>
      /** `${lang}\0${footer}\0${english}` -> what the row draws. */
      translations: Record<string, string>
      /** `/lang <code>`: replies drawn in this language whatever the prompt; `auto` follows the prompt. */
      pin: LangBridgeLang | 'auto'
      /** `/lang direct`: no translation, the model answers in the person's language. */
      mode: 'bridge' | 'direct'
      /** The main loop's last answer, in English: `/lang original` and `/lang retry`. */
      lastReply: string
    }
  }
}
