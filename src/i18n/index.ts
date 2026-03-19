import { useSettingsStore } from '../stores/settingsStore'
import { zh } from './zh'
import { en } from './en'
import type { Translations } from './zh'
import type { Language } from '../types'

const translations: Record<Language, Translations> = { zh, en }

/**
 * Returns the translations object for the current language.
 * Usage: const t = useT(); then t.login.title, t.sidebar.signOut, etc.
 */
export function useT(): Translations {
  const language = useSettingsStore(s => s.settings.language)
  return translations[language] || translations.zh
}

/**
 * Get translations without React hook (for use outside components).
 */
export function getT(): Translations {
  const language = useSettingsStore.getState().settings.language
  return translations[language] || translations.zh
}
