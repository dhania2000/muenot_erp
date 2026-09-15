"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FileText, Scale, Receipt, ScrollText, Award, GitCompareArrows, Percent, Users, CalendarClock, HandCoins } from "lucide-react"
import { currentFy, FyPicker, isDeductor, type Direction } from "./shared"
import { DeductorBanner } from "./deductor-banner"
import { FilingStage } from "./filing-stage"
import { DeducteesStage } from "./deductees-stage"
import { LiabilityStage } from "./liability-stage"
import { ChallansStage } from "./challans-stage"
import { ReturnsStage } from "./returns-stage"
import { CertificatesStage } from "./certificates-stage"
import { CalendarStage } from "./calendar-stage"
import { ReconciliationStage } from "./reconciliation-stage"
import { CustomerTdsStage } from "./customer-tds-stage"
import { ReferenceStage } from "./reference-stage"

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "payable", label: "Payable · Vendors" },
  { value: "employee", label: "Payable · Employees" },
  { value: "receivable", label: "Receivable · 26AS" },
]

type StageId =
  | "filing"
  | "deductees"
  | "liability"
  | "challans"
  | "returns"
  | "certificates"
  | "calendar"
  | "customer"
  | "reconciliation"
  | "rules"

const STAGES: { id: StageId; label: string; icon: typeof FileText; deductorOnly?: boolean; receivableOnly?: boolean }[] = [
  { id: "filing", label: "Filing", icon: FileText },
  { id: "deductees", label: "Deductees", icon: Users },
  { id: "liability", label: "Liability", icon: Scale },
  { id: "challans", label: "Challans", icon: Receipt, deductorOnly: true },
  { id: "returns", label: "Returns", icon: ScrollText, deductorOnly: true },
  { id: "certificates", label: "Certificates", icon: Award, deductorOnly: true },
  { id: "calendar", label: "Calendar", icon: CalendarClock, deductorOnly: true },
  { id: "customer", label: "Customer TDS", icon: HandCoins, receivableOnly: true },
  { id: "reconciliation", label: "Reconciliation", icon: GitCompareArrows },
  { id: "rules", label: "Rule master", icon: Percent },
]

export function TdsWorkspace() {
  const [direction, setDirection] = useState<Direction>("payable")
  const [fy, setFy] = useState(currentFy())
  const [stage, setStage] = useState<StageId>("filing")

  const deductor = isDeductor(direction)
  const stages = STAGES.filter((s) => {
    if (s.deductorOnly && !deductor) return false
    if (s.receivableOnly && deductor) return false
    return true
  })

  function pickDirection(next: Direction) {
    setDirection(next)
    const nextDeductor = isDeductor(next)
    // Fall back to a stage that exists for the new direction.
    if (!nextDeductor && ["challans", "returns", "certificates", "calendar"].includes(stage)) {
      setStage("filing")
    }
    if (nextDeductor && stage === "customer") {
      setStage("filing")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <DeductorBanner />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Tabs value={direction} onValueChange={(v) => pickDirection(v as Direction)}>
          <TabsList>
            {DIRECTIONS.map((d) => (
              <TabsTrigger key={d.value} value={d.value}>
                {d.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <FyPicker value={fy} onChange={setFy} />
      </div>

      <Tabs value={stage} onValueChange={(v) => setStage(v as StageId)} className="flex flex-col gap-6">
        <TabsList className="flex w-full flex-wrap justify-start">
          {stages.map((s) => {
            const Icon = s.icon
            return (
              <TabsTrigger key={s.id} value={s.id} className="gap-1.5">
                <Icon className="h-4 w-4" />
                {s.label}
              </TabsTrigger>
            )
          })}
        </TabsList>

        <TabsContent value="filing">
          <FilingStage direction={direction} />
        </TabsContent>
        <TabsContent value="deductees">
          <DeducteesStage direction={direction} fy={fy} />
        </TabsContent>
        <TabsContent value="liability">
          <LiabilityStage direction={direction} fy={fy} />
        </TabsContent>
        {deductor ? (
          <>
            <TabsContent value="challans">
              <ChallansStage direction={direction} fy={fy} />
            </TabsContent>
            <TabsContent value="returns">
              <ReturnsStage direction={direction} fy={fy} />
            </TabsContent>
            <TabsContent value="certificates">
              <CertificatesStage direction={direction} fy={fy} />
            </TabsContent>
            <TabsContent value="calendar">
              <CalendarStage direction={direction} fy={fy} />
            </TabsContent>
          </>
        ) : null}
        <TabsContent value="reconciliation">
          <ReconciliationStage direction={direction} fy={fy} />
        </TabsContent>
        <TabsContent value="rules">
          <ReferenceStage />
        </TabsContent>
      </Tabs>
    </div>
  )
}
