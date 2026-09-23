"use client"

import { useEffect, useRef } from "react"

/**
 * deep-link support for the global command palette's "Create <record>"
 * actions.
 *
 * A create command navigates to a module list page with `?new=1`. On arrival
 * this hook opens that page's own create dialog exactly once and then strips the
 * `new` param from the URL (via history.replaceState, so it does not add a
 * history entry) — a refresh or back-navigation therefore never re-opens the
 * dialog. The list page keeps sole ownership of its create UI and permission
 * gating; the palette only asks it to open.
 *
 * `enabled` lets a caller withhold the trigger when the viewer lacks create
 * permission, so the URL param can never force open a form the page itself
 * would not offer.
 */
export function useNewRecordParam(onNew: () => void, enabled = true) {
  const callback = useRef(onNew)
  callback.current = onNew
  const fired = useRef(false)

  useEffect(() => {
    if (!enabled || fired.current) return
    if (typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (url.searchParams.get("new") !== "1") return

    fired.current = true
    callback.current()
    url.searchParams.delete("new")
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [enabled])
}
