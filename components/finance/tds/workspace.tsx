"use client"

import { useState } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FileText, Scale, Receipt, ScrollText, Award, GitCompareArrows } from "lucide-react"
import { currentFy, FyPicker, isDeductor, type Direction } from "./shared"
import { FilingStage } from "./filing-stage"
import { LiabilityStage } from "./liability-stage"
import { ChallansStage } from "./challans-stage"
import { ReturnsStage } from "./returns-stage"
import { CertificatesStage } from "./certificates-stage"
import { ReconciliationStage } from "./reconciliation-stage"

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: "payable", label: "Payable · Vendors" },
  { value: "employee", label: "Payable · Employees" },
  { value: "receivable", label: "Receivable · 26AS" },
]

type StageId = "filing" | "liability" | "challans" | "returns" | "certificates" | "reconciliation"

const STAGES: { id: StageId; label: string; icon: typeof FileText; deductorOnly?: boolean }[] = [
  { id: "filing", label: "Filing", icon: FileText },
  { id: "liability", label: "Liability", icon: Scale },
  { id: "challans", label: "Challans", icon: Receipt, deductorOnly: true },
  { id: "returns", label: "Returns", icon: ScrollText, deductorOnly: true },
  { id: "certificates", label: "Certificates", icon: Award, deductorOnly: true },
  { id: "reconciliation", label: "Reconciliation", icon: GitCompareArrows },
]

export function TdsWorkspace() {
  const [direction, setDirection] = useState<Direction>("payable")
  const [fy, setFy] = useState(currentFy())
  const [stage, setStage] = useState<StageId>("filing")

  const deductor = isDeductor(direction)
  const stages = STAGES.filter((s) => !s.deductorOnly || deductor)

  function pickDirection(next: Direction) {
    setDirection(next)
    // Fall back to a stage that exists for the new direction.
    if (!isDeductor(next) && ["challans", "returns", "certificates"].includes(stage)) {
      setStage("filing")
    }
  }

  return (
    <div className="flex flex-col gap-6">
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
          </>
        ) : null}
        <TabsContent value="reconciliation">
          <ReconciliationStage direction={direction} fy={fy} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
