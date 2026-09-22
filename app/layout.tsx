import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import { Toaster } from '@/components/ui/sonner'
import { ThemeProvider } from '@/components/theme-provider'
import { CookieConsent } from '@/components/providers/cookie-consent'
import { LanguageProvider } from '@/components/providers/language-provider'
import { AutoTranslate } from '@/components/providers/auto-translate'
import { DEFAULT_LANGUAGE, getLanguage, isSupportedLanguage } from '@/lib/i18n/languages'
import './globals.css'

export const metadata: Metadata = {
  title: 'Muenot Management Portal',
  description: 'Muenot Technologies ERP',
  icons: {
    icon: [
      {
        url: '/muenot-favicon.png',
        type: 'image/png',
      },
    ],
    apple: '/muenot-favicon.png',
  },
}

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: 'white' },
    { media: '(prefers-color-scheme: dark)', color: 'black' },
  ],
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const cookieStore = await cookies()
  const cookieLanguage = cookieStore.get('app_lang')?.value
  const initialLanguage = isSupportedLanguage(cookieLanguage) ? cookieLanguage : DEFAULT_LANGUAGE
  const dir = getLanguage(initialLanguage)?.dir ?? 'ltr'

  return (
    <html lang={initialLanguage} dir={dir} suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider>
          <LanguageProvider initialLanguage={initialLanguage}>
            {children}
            <AutoTranslate />
            <CookieConsent />
            <Toaster />
          </LanguageProvider>
        </ThemeProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
