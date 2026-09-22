'use client'

import { useEffect, useRef } from 'react'
import { useLanguage } from '@/components/providers/language-provider'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE'])
const TRANSLATABLE_ATTRS = ['placeholder', 'aria-label', 'title'] as const

// Requires at least one letter from a broad set of world scripts so we skip
// pure numbers, symbols, currency amounts, dates, etc.
const HAS_LETTERS =
  /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0E00-\u0E7F\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7A3]/

// Original (source-language) text keyed by DOM node/element so we can restore
// it instantly when the user switches back to English, without another
// network round trip.
const originalText = new WeakMap<Text, string>()
const originalAttr = new WeakMap<Element, Partial<Record<string, string>>>()
// `${lang}::${sourceText}` -> translated text. Shared across the whole tab.
const translationCache = new Map<string, string>()

function isTranslatable(value: string | null) {
  if (!value) return false
  const trimmed = value.trim()
  return trimmed.length >= 2 && HAS_LETTERS.test(trimmed)
}

function shouldSkipElement(el: Element | null) {
  if (!el) return true
  if (SKIP_TAGS.has(el.tagName)) return true
  if ((el as HTMLElement).isContentEditable) return true
  return !!el.closest('[data-i18n-skip]')
}

function collectFromRoot(root: Element, texts: Set<Text>, attrs: Set<Element>) {
  if (root.nodeType === Node.ELEMENT_NODE && !shouldSkipElement(root)) {
    for (const attr of TRANSLATABLE_ATTRS) {
      if (isTranslatable(root.getAttribute(attr))) attrs.add(root)
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT
      return isTranslatable(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    },
  })
  let current: Node | null
  while ((current = walker.nextNode())) texts.add(current as Text)

  if (root.querySelectorAll) {
    root.querySelectorAll(TRANSLATABLE_ATTRS.map((a) => `[${a}]`).join(',')).forEach((el) => {
      if (shouldSkipElement(el)) return
      for (const attr of TRANSLATABLE_ATTRS) {
        if (isTranslatable(el.getAttribute(attr))) attrs.add(el)
      }
    })
  }
}

async function fetchTranslations(texts: string[], lang: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts, target: lang }),
    })
    if (!res.ok) return result
    const data = await res.json()
    const translations = Array.isArray(data.translations) ? data.translations : []
    texts.forEach((text, i) => {
      if (typeof translations[i] === 'string') result.set(text, translations[i])
    })
  } catch (error) {
    console.error('[v0] auto-translate fetch failed', error)
  }
  return result
}

export function AutoTranslate() {
  const { language } = useLanguage()
  const pendingTextRef = useRef<Set<Text>>(new Set())
  const pendingAttrRef = useRef<Set<Element>>(new Set())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const isEnglish = language === 'en'

    async function translateNow(texts: Text[], attrEls: Element[]) {
      const byOriginal = new Map<string, Text[]>()
      for (const node of texts) {
        const original = originalText.get(node) ?? node.nodeValue ?? ''
        if (!originalText.has(node)) originalText.set(node, original)
        const cached = translationCache.get(`${language}::${original}`)
        if (cached) {
          if (node.nodeValue !== cached) node.nodeValue = cached
          continue
        }
        if (!byOriginal.has(original)) byOriginal.set(original, [])
        byOriginal.get(original)!.push(node)
      }

      const attrByOriginal = new Map<string, Array<{ el: Element; attr: string }>>()
      for (const el of attrEls) {
        for (const attr of TRANSLATABLE_ATTRS) {
          const value = el.getAttribute(attr)
          if (!isTranslatable(value)) continue
          const stored = originalAttr.get(el) ?? {}
          const original = stored[attr] ?? value!
          if (!(attr in stored)) originalAttr.set(el, { ...stored, [attr]: original })
          const cached = translationCache.get(`${language}::${original}`)
          if (cached) {
            if (el.getAttribute(attr) !== cached) el.setAttribute(attr, cached)
            continue
          }
          if (!attrByOriginal.has(original)) attrByOriginal.set(original, [])
          attrByOriginal.get(original)!.push({ el, attr })
        }
      }

      const uniqueSources = [...new Set([...byOriginal.keys(), ...attrByOriginal.keys()])]
      if (uniqueSources.length === 0) return

      const CHUNK = 60
      for (let i = 0; i < uniqueSources.length; i += CHUNK) {
        const chunk = uniqueSources.slice(i, i + CHUNK)
        const translated = await fetchTranslations(chunk, language)
        for (const [original, value] of translated) {
          translationCache.set(`${language}::${original}`, value)
          for (const node of byOriginal.get(original) || []) node.nodeValue = value
          for (const { el, attr } of attrByOriginal.get(original) || []) el.setAttribute(attr, value)
        }
      }
    }

    function restoreOriginals(root: Element) {
      const texts = new Set<Text>()
      const attrs = new Set<Element>()
      collectFromRoot(root, texts, attrs)
      for (const node of texts) {
        const original = originalText.get(node)
        if (original !== undefined && node.nodeValue !== original) node.nodeValue = original
      }
      for (const el of attrs) {
        const stored = originalAttr.get(el)
        if (!stored) continue
        for (const attr of TRANSLATABLE_ATTRS) {
          if (stored[attr] !== undefined && el.getAttribute(attr) !== stored[attr]) {
            el.setAttribute(attr, stored[attr]!)
          }
        }
      }
    }

    function flushPending() {
      const texts = [...pendingTextRef.current]
      const attrEls = [...pendingAttrRef.current]
      pendingTextRef.current.clear()
      pendingAttrRef.current.clear()
      if (isEnglish) return
      if (texts.length || attrEls.length) void translateNow(texts, attrEls)
    }

    function schedule() {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(flushPending, 250)
    }

    if (isEnglish) {
      restoreOriginals(document.body)
    } else {
      const texts = new Set<Text>()
      const attrs = new Set<Element>()
      collectFromRoot(document.body, texts, attrs)
      void translateNow([...texts], [...attrs])
    }

    // Watches for new content (route changes, async data, tab switches) and
    // for the app re-rendering text nodes back to their source language.
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach((added) => {
            if (added.nodeType === Node.TEXT_NODE) {
              if (!shouldSkipElement((added as Text).parentElement) && isTranslatable(added.nodeValue)) {
                pendingTextRef.current.add(added as Text)
              }
            } else if (added.nodeType === Node.ELEMENT_NODE) {
              const texts = new Set<Text>()
              const attrs = new Set<Element>()
              collectFromRoot(added as Element, texts, attrs)
              texts.forEach((t) => pendingTextRef.current.add(t))
              attrs.forEach((a) => pendingAttrRef.current.add(a))
            }
          })
        } else if (mutation.type === 'characterData' && !isEnglish) {
          const node = mutation.target as Text
          if (shouldSkipElement(node.parentElement)) continue
          const original = originalText.get(node)
          const expected = original ? translationCache.get(`${language}::${original}`) : undefined
          if (expected && node.nodeValue !== expected) {
            // Something (e.g. a re-render) reset this node back to its source
            // text. Re-queue it so it gets translated again.
            pendingTextRef.current.add(node)
          }
        } else if (mutation.type === 'attributes' && !isEnglish) {
          const el = mutation.target as Element
          const attr = mutation.attributeName
          if (!attr || !TRANSLATABLE_ATTRS.includes(attr as (typeof TRANSLATABLE_ATTRS)[number])) continue
          if (shouldSkipElement(el)) continue
          const stored = originalAttr.get(el)
          const original = stored?.[attr]
          const expected = original ? translationCache.get(`${language}::${original}`) : undefined
          if (expected && el.getAttribute(attr) !== expected) {
            pendingAttrRef.current.add(el)
          }
        }
      }
      schedule()
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRS],
    })

    return () => {
      observer.disconnect()
      if (timerRef.current) clearTimeout(timerRef.current)
      pendingTextRef.current.clear()
      pendingAttrRef.current.clear()
    }
  }, [language])

  return null
}
