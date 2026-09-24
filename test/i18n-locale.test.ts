import { describe, it, expect } from 'vitest'
import {
  localeForLanguage,
  directionForLanguage,
  isRtlLanguage,
  formatDateLocalized,
  formatTimeLocalized,
  formatNumberLocalized,
  formatCurrencyLocalized,
  formatPercentLocalized,
  formatCompactNumberLocalized,
  formatRelativeTimeLocalized,
} from '@/lib/i18n/locale'

// A fixed instant (UTC) so date/time assertions are deterministic.
const SAMPLE = new Date('2026-03-14T09:26:53.000Z')

describe('SPEC 160 — locale resolution & direction', () => {
  it('maps UI languages to concrete BCP-47 locales', () => {
    expect(localeForLanguage('en')).toBe('en-US')
    expect(localeForLanguage('de')).toBe('de-DE')
    expect(localeForLanguage('ar')).toBe('ar')
    expect(localeForLanguage('ja')).toBe('ja-JP')
  })

  it('falls back to the default locale for unknown/empty codes', () => {
    expect(localeForLanguage(undefined)).toBe('en-US')
    expect(localeForLanguage('zz')).toBe('en-US')
  })

  it('detects RTL languages', () => {
    expect(directionForLanguage('ar')).toBe('rtl')
    expect(directionForLanguage('he')).toBe('rtl')
    expect(directionForLanguage('fa')).toBe('rtl')
    expect(directionForLanguage('ur')).toBe('rtl')
    expect(isRtlLanguage('ar')).toBe(true)
    expect(isRtlLanguage('en')).toBe(false)
    expect(directionForLanguage('en')).toBe('ltr')
  })
})

describe('SPEC 160 — number & currency formatting', () => {
  it('uses locale-specific grouping and decimal separators', () => {
    // en-US groups with comma, de-DE groups with dot and uses comma decimal.
    expect(formatNumberLocalized(1234567.89, { locale: 'en-US' })).toBe('1,234,567.89')
    expect(formatNumberLocalized(1234567.89, { locale: 'de-DE' })).toBe('1.234.567,89')
  })

  it('formats currency with locale-driven symbol placement', () => {
    const usd = formatCurrencyLocalized(1234.5, 'USD', { locale: 'en-US' })
    expect(usd).toContain('1,234.50')
    expect(usd).toContain('$')

    const eur = formatCurrencyLocalized(1234.5, 'EUR', { locale: 'de-DE' })
    expect(eur).toContain('1.234,50')
    expect(eur).toContain('€')
  })

  it('honors currency-specific fraction digits', () => {
    // JPY has 0 fraction digits; BHD has 3.
    expect(formatCurrencyLocalized(1234, 'JPY', { locale: 'ja-JP' })).not.toContain('.')
    expect(formatCurrencyLocalized(1.5, 'BHD', { locale: 'en-US' })).toContain('1.500')
  })

  it('formats percentages from a ratio', () => {
    expect(formatPercentLocalized(0.1256, { locale: 'en-US' })).toBe('12.56%')
  })

  it('formats compact numbers', () => {
    expect(formatCompactNumberLocalized(1200, { locale: 'en-US' })).toBe('1.2K')
  })

  it('coerces string/nullish inputs safely', () => {
    expect(formatNumberLocalized('4200', { locale: 'en-US' })).toBe('4,200')
    expect(formatNumberLocalized(null, { locale: 'en-US' })).toBe('0')
  })
})

describe('SPEC 160 — date & time formatting', () => {
  it('renders dates in a fixed timezone consistently', () => {
    const en = formatDateLocalized(SAMPLE, { locale: 'en-US', timeZone: 'UTC' })
    expect(en).toContain('2026')
    expect(en).toContain('Mar')
    expect(en).toContain('14')
  })

  it('respects the timezone when formatting time', () => {
    // 09:26 UTC is 14:56 in India (UTC+5:30).
    const utc = formatTimeLocalized(SAMPLE, { locale: 'en-GB', timeZone: 'UTC' })
    const ist = formatTimeLocalized(SAMPLE, { locale: 'en-GB', timeZone: 'Asia/Kolkata' })
    expect(utc).toContain('09:26')
    expect(ist).toContain('14:56')
  })

  it('handles bare clock strings without applying a zone offset', () => {
    expect(formatTimeLocalized('14:56', { locale: 'en-GB', timeZone: 'Asia/Kolkata' })).toContain(
      '14:56',
    )
  })

  it('returns empty string for nullish dates', () => {
    expect(formatDateLocalized(null)).toBe('')
    expect(formatDateLocalized(undefined)).toBe('')
  })

  it('formats relative time', () => {
    const from = new Date('2026-03-14T12:00:00.000Z')
    expect(
      formatRelativeTimeLocalized(new Date('2026-03-11T12:00:00.000Z'), { locale: 'en-US', from }),
    ).toBe('3 days ago')
    expect(
      formatRelativeTimeLocalized(new Date('2026-03-14T14:00:00.000Z'), { locale: 'en-US', from }),
    ).toBe('in 2 hours')
  })
})
