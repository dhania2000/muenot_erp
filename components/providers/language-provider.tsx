'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DEFAULT_LANGUAGE, getLanguage, isSupportedLanguage } from '@/lib/i18n/languages'
import { localeForLanguage } from '@/lib/i18n/locale'

const COOKIE_NAME = 'app_lang'
const STORAGE_KEY = 'app_lang'

type LanguageContextValue = {
  language: string
  /** BCP-47 locale derived from the active language, for `Intl` formatting. */
  locale: string
  dir: 'ltr' | 'rtl'
  setLanguage: (code: string) => void
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE,
  locale: localeForLanguage(DEFAULT_LANGUAGE),
  dir: 'ltr',
  setLanguage: () => {},
})

export function useLanguage() {
  return useContext(LanguageContext)
}

export function LanguageProvider({
  children,
  initialLanguage,
}: {
  children: ReactNode
  initialLanguage?: string
}) {
  const [language, setLanguageState] = useState<string>(() =>
    isSupportedLanguage(initialLanguage) ? initialLanguage : DEFAULT_LANGUAGE,
  )

  // A returning visitor's saved preference may not have reached the server yet
  // (e.g. very first request before the cookie existed). Reconcile once on mount.
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored && isSupportedLanguage(stored) && stored !== language) {
      setLanguageState(stored)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const dir = useMemo(() => getLanguage(language)?.dir ?? 'ltr', [language])
  const locale = useMemo(() => localeForLanguage(language), [language])

  useEffect(() => {
    document.documentElement.lang = language
    document.documentElement.dir = dir
  }, [language, dir])

  const setLanguage = useCallback((code: string) => {
    if (!isSupportedLanguage(code)) return
    setLanguageState(code)
    window.localStorage.setItem(STORAGE_KEY, code)
    document.cookie = `${COOKIE_NAME}=${code}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`
  }, [])

  const value = useMemo(
    () => ({ language, locale, dir, setLanguage }),
    [language, locale, dir, setLanguage],
  )

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}
