import type { Locale } from "./types"

export function detectLocale(configLocale?: string): Locale {
  if (configLocale === "zh") return "zh"

  const lang = process.env.LANG ?? ""
  if (/^zh/i.test(lang)) return "zh"

  try {
    const intl = new Intl.DateTimeFormat().resolvedOptions().locale
    if (/^zh/i.test(intl)) return "zh"
  } catch {}

  return "en"
}
