'use client'

import { Check, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useLanguage } from '@/components/providers/language-provider'
import { LANGUAGES } from '@/lib/i18n/languages'

/**
 * Inline language switcher meant to be placed directly in a header/top bar
 * (not fixed/floating). Renders a compact icon button on narrow layouts and
 * shows the current language name once there's room.
 */
export function LanguageWidget({ className }: { className?: string }) {
  const { language, setLanguage } = useLanguage()
  const current = LANGUAGES.find((lang) => lang.code === language) ?? LANGUAGES[0]

  return (
    <div data-i18n-skip className={cn('print:hidden', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground hover:bg-primary/10 hover:text-primary"
              aria-label="Change portal language"
            />
          }
        >
          <Globe className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">{current.nativeName}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
          {LANGUAGES.map((lang) => (
            <DropdownMenuItem
              key={lang.code}
              onClick={() => setLanguage(lang.code)}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex flex-col">
                <span className="text-sm">{lang.nativeName}</span>
                <span className="text-xs text-muted-foreground">{lang.name}</span>
              </span>
              {lang.code === language && <Check className="size-4 text-primary" aria-hidden="true" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
