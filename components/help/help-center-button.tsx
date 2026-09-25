"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"
import { CircleHelp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { HelpCenterSheet, ONBOARDING_KEY, UPDATES_KEY, type HelpTab } from "@/components/help/help-center-sheet"

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "same-origin" })
  if (!res.ok) throw new Error("Request failed")
  return res.json()
}

const AUTO_OPEN_FLAG = "muenot.onboarding.autoOpened"

/**
 * Header help trigger. Shows an unread dot for new product updates and, for
 * tenant admins, resumes the first-run setup checklist once per browser
 * session until it is completed or dismissed (state itself lives server-side).
 */
export function HelpCenterButton({ pathname, isAdmin }: { pathname: string; isAdmin: boolean }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<HelpTab>("help")
  const updates = useSWR<{ unread: number }>(UPDATES_KEY, fetcher, { refreshInterval: 300_000 })
  const onboarding = useSWR<{ checklist: { complete: boolean; dismissed: boolean } }>(isAdmin ? ONBOARDING_KEY : null, fetcher)

  const checklist = onboarding.data?.checklist
  useEffect(() => {
    if (!checklist || checklist.complete || checklist.dismissed) return
    if (sessionStorage.getItem(AUTO_OPEN_FLAG)) return
    sessionStorage.setItem(AUTO_OPEN_FLAG, "1")
    setTab("setup")
    setOpen(true)
  }, [checklist])

  const unread = updates.data?.unread ?? 0
  const setupPending = !!checklist && !checklist.complete && !checklist.dismissed

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={unread ? `Help and product updates, ${unread} unread` : "Help and product updates"}
        className="relative text-muted-foreground hover:bg-primary/10 hover:text-primary"
        onClick={() => {
          setTab(unread > 0 ? "updates" : setupPending ? "setup" : "help")
          setOpen(true)
        }}
      >
        <CircleHelp className="size-5" />
        {(unread > 0 || setupPending) && (
          <span aria-hidden className="absolute right-1 top-1 size-2 rounded-full bg-primary ring-2 ring-card" />
        )}
      </Button>
      <HelpCenterSheet open={open} onOpenChange={setOpen} pathname={pathname} isAdmin={isAdmin} tab={tab} onTabChange={setTab} />
    </>
  )
}
