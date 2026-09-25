"use client"

import useSWR from "swr"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ONBOARDING_KEY, SetupChecklist } from "@/components/help/help-center-sheet"

const fetcher = async (url: string) => {
  const res = await fetch(url, { credentials: "same-origin" })
  if (!res.ok) throw new Error("Request failed")
  return res.json()
}

/**
 * Resumable first-login checklist on the admin dashboard. Shares the SWR key
 * with the help panel's Setup tab, so progress stays in sync, and disappears
 * once setup is complete or dismissed.
 */
export function OnboardingChecklistCard() {
  const { data } = useSWR<{ checklist: { complete: boolean; dismissed: boolean } }>(ONBOARDING_KEY, fetcher)
  const checklist = data?.checklist
  if (!checklist || checklist.complete || checklist.dismissed) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Finish setting up your workspace</CardTitle>
        <CardDescription>Pick up where you left off. Steps complete automatically as you configure each area.</CardDescription>
      </CardHeader>
      <CardContent>
        <SetupChecklist compact />
      </CardContent>
    </Card>
  )
}
