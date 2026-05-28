import type { Locale, Dictionary } from "./types"
import en from "./en"
import zh from "./zh"
import { detectLocale } from "./detect"

let currentLocale: Locale = "en"
let dict: Dictionary = { ...en }

function loadDict(locale: Locale): Dictionary {
  if (locale === "zh") return { ...en, ...zh }
  return { ...en }
}

export function setLocale(locale: Locale): void {
  currentLocale = locale
  dict = loadDict(locale)
}

export function getLocale(): Locale {
  return currentLocale
}

export function t(key: string): string
export function t(key: string, params?: Record<string, string | number>): string
export function t(key: string, params?: Record<string, string | number>): string {
  let text = dict[key]
  if (text === undefined) text = key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{{${k}}}`, String(v))
    }
  }
  return text
}

// Auto-detect and set locale at module load time
setLocale(detectLocale())
