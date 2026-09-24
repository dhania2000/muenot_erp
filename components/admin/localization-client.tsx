'use client'

/**
 * SPEC 160 — Localization control & preview screen.
 *
 * A real management surface for the localization framework. It drives the live
 * app language preference through `useLanguage` (persisted via cookie +
 * localStorage) and lets an operator preview how dates, numbers, currency and
 * relative time render for the chosen language, currency and timezone — using
 * the same `Intl`-based core (`lib/i18n/locale`) the rest of the app formats
 * with. Currency/timezone choices are persisted locally so the preview reflects
 * a returning operator's last configuration.
 */

import { useEffect, useMemo, useState } from 'react'
import { Globe, Languages as LanguagesIcon, Check } from 'lucide-react'
import { useLanguage } from '@/components/providers/language-provider'
import { LANGUAGES } from '@/lib/i18n/languages'
import {
  localeForLanguage,
  directionForLanguage,
  formatDateLocalized,
  formatTimeLocalized,
  formatDateTimeLocalized,
  formatNumberLocalized,
  formatCurrencyLocalized,
  formatPercentLocalized,
  formatCompactNumberLocalized,
  formatRelativeTimeLocalized,
} from '@/lib/i18n/locale'
import { DEFAULT_TIME_ZONE, detectUserTimeZone, isValidTimeZone } from '@/lib/timezone'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const CURRENCIES: Array<{ code: string; label: string }> = [
  { code: 'USD', label: 'US Dollar' },
  { code: 'EUR', label: 'Euro' },
  { code: 'GBP', label: 'British Pound' },
  { code: 'INR', label: 'Indian Rupee' },
  { code: 'JPY', label: 'Japanese Yen' },
  { code: 'CNY', label: 'Chinese Yuan' },
  { code: 'AED', label: 'UAE Dirham' },
  { code: 'SAR', label: 'Saudi Riyal' },
  { code: 'BHD', label: 'Bahraini Dinar' },
  { code: 'BRL', label: 'Brazilian Real' },
  { code: 'RUB', label: 'Russian Ruble' },
  { code: 'CHF', label: 'Swiss Franc' },
  { code: 'CAD', label: 'Canadian Dollar' },
  { code: 'AUD', label: 'Australian Dollar' },
  { code: 'ZAR', label: 'South African Rand' },
]

const TIME_ZONES = [
  'Asia/Kolkata',
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Moscow',
  'Africa/Nairobi',
  'Asia/Dubai',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Australia/Sydney',
]

const CURRENCY_KEY = 'app_locale_currency'
const TZ_KEY = 'app_locale_timezone'

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums text-right" dir="auto">
        {value}
      </span>
    </div>
  )
}

export function LocalizationClient() {
  const { language, setLanguage } = useLanguage()

  const [currency, setCurrency] = useState('USD')
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE)

  // Restore previously chosen currency/timezone; default timezone to the
  // operator's detected zone the first time.
  useEffect(() => {
    const savedCurrency = window.localStorage.getItem(CURRENCY_KEY)
    if (savedCurrency && CURRENCIES.some((c) => c.code === savedCurrency)) setCurrency(savedCurrency)

    const savedTz = window.localStorage.getItem(TZ_KEY)
    if (savedTz && isValidTimeZone(savedTz)) {
      setTimeZone(savedTz)
    } else {
      const detected = detectUserTimeZone()
      if (detected && isValidTimeZone(detected)) setTimeZone(detected)
    }
  }, [])

  function handleCurrency(code: string) {
    setCurrency(code)
    window.localStorage.setItem(CURRENCY_KEY, code)
  }

  function handleTimeZone(tz: string) {
    setTimeZone(tz)
    window.localStorage.setItem(TZ_KEY, tz)
  }

  const locale = useMemo(() => localeForLanguage(language), [language])
  const dir = useMemo(() => directionForLanguage(language), [language])

  // A fixed sample instant so the preview is deterministic across renders,
  // plus a live "now" for the relative-time example.
  const sample = useMemo(() => new Date('2026-03-14T09:26:53.000Z'), [])
  const now = Date.now()

  const activeLanguage = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0]

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <LanguagesIcon className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              SPEC 160
            </span>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">
              Multi-Language / Localization
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
              Set the portal language and preview locale-aware date, number, currency and timezone
              formatting. The whole interface translates live as you change the language.
            </p>
          </div>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="size-4 text-primary" aria-hidden="true" />
              Locale preferences
            </CardTitle>
            <CardDescription>
              Choose the interface language, reporting currency and display timezone.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="loc-language">Language preference</Label>
              <Select value={language} onValueChange={setLanguage}>
                <SelectTrigger id="loc-language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {LANGUAGES.map((lang) => (
                    <SelectItem key={lang.code} value={lang.code}>
                      <span className="flex items-center gap-2">
                        <span>{lang.nativeName}</span>
                        <span className="text-xs text-muted-foreground">{lang.name}</span>
                        {lang.dir === 'rtl' && (
                          <Badge variant="secondary" className="text-[10px]">
                            RTL
                          </Badge>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="loc-currency">Currency</Label>
              <Select value={currency} onValueChange={handleCurrency}>
                <SelectTrigger id="loc-currency" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{c.code}</span>
                        <span className="text-xs text-muted-foreground">{c.label}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="loc-timezone">Timezone</Label>
              <Select value={timeZone} onValueChange={handleTimeZone}>
                <SelectTrigger id="loc-timezone" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-80">
                  {TIME_ZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Active language</dt>
                <dd className="font-medium" dir="auto">
                  {activeLanguage.nativeName}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">BCP-47 locale</dt>
                <dd className="font-medium tabular-nums">{locale}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Text direction</dt>
                <dd className="font-medium uppercase">{dir}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Supported languages</dt>
                <dd className="font-medium tabular-nums">{LANGUAGES.length}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card data-i18n-skip>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Check className="size-4 text-primary" aria-hidden="true" />
              Formatting preview
            </CardTitle>
            <CardDescription>
              Live output from the shared <code>Intl</code> formatting core for the selected locale.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <section aria-label="Date and time formats">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Dates &amp; time
              </h3>
              <PreviewRow label="Date" value={formatDateLocalized(sample, { locale, timeZone })} />
              <PreviewRow
                label="Long date"
                value={formatDateLocalized(sample, {
                  locale,
                  timeZone,
                  dateStyle: 'full',
                })}
              />
              <PreviewRow label="Time" value={formatTimeLocalized(sample, { locale, timeZone })} />
              <PreviewRow
                label="Date & time"
                value={formatDateTimeLocalized(sample, { locale, timeZone })}
              />
              <PreviewRow
                label="Relative"
                value={formatRelativeTimeLocalized(now - 1000 * 60 * 60 * 26, { locale })}
              />
            </section>

            <Separator className="my-4" />

            <section aria-label="Number and currency formats">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Numbers &amp; currency
              </h3>
              <PreviewRow label="Number" value={formatNumberLocalized(1234567.891, { locale })} />
              <PreviewRow
                label="Compact"
                value={formatCompactNumberLocalized(1234567, { locale })}
              />
              <PreviewRow label="Percent" value={formatPercentLocalized(0.1256, { locale })} />
              <PreviewRow
                label="Currency"
                value={formatCurrencyLocalized(1234567.891, currency, { locale })}
              />
              <PreviewRow
                label="Currency (compact)"
                value={formatCurrencyLocalized(1234567.891, currency, {
                  locale,
                  notation: 'compact',
                })}
              />
            </section>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
