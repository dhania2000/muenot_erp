"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import { CalendarDays, Plus } from "lucide-react"
import { MarketingHeader } from "@/components/marketing/marketing-shared"

type Column = "Backlog" | "Planned" | "In Progress" | "Published"

type Item = { id: string; title: string; channel: string; due: string; column: Column }

const COLUMNS: Column[] = ["Backlog", "Planned", "In Progress", "Published"]

const SEED: Item[] = []

const CHANNEL_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  Email: "default",
  Social: "secondary",
  Blog: "outline",
  "Paid Ads": "secondary",
}

export function MarketingPlannerClient() {
  const [items, setItems] = useState<Item[]>(SEED)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: "", channel: "", due: "" })

  function add() {
    if (!form.title) return
    setItems((prev) => [
      { id: `T-${prev.length + 1}`, title: form.title, channel: form.channel || "Email", due: form.due || "TBD", column: "Backlog" },
      ...prev,
    ])
    setForm({ title: "", channel: "", due: "" })
    setOpen(false)
  }

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Marketing Planner"
        description="Plan and schedule your content calendar across channels, from backlog idea to published."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              render={
                <Button>
                  <Plus className="size-4" />
                  Add Item
                </Button>
              }
            />
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Add Planner Item</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                {(
                  [
                    ["title", "Title"],
                    ["channel", "Channel"],
                    ["due", "Due date"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="flex flex-col gap-1.5">
                    <Label htmlFor={key} className="text-xs text-muted-foreground">
                      {label}
                    </Label>
                    <Input
                      id={key}
                      value={form[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                <Button onClick={add}>Add item</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => {
          const colItems = items.filter((i) => i.column === col)
          return (
            <div key={col} className="flex flex-col gap-3">
              <div className="flex items-center justify-between px-1">
                <span className="text-sm font-medium">{col}</span>
                <Badge variant="outline">{colItems.length}</Badge>
              </div>
              <div className="flex flex-col gap-3">
                {colItems.map((item) => (
                  <Card key={item.id}>
                    <CardContent className="flex flex-col gap-2 pt-4">
                      <p className="text-sm font-medium leading-snug text-pretty">{item.title}</p>
                      <div className="flex items-center justify-between">
                        <Badge variant={CHANNEL_VARIANT[item.channel] ?? "outline"}>{item.channel}</Badge>
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <CalendarDays className="size-3" />
                          {item.due}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                ))}
                {colItems.length === 0 && (
                  <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
                    Nothing here
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}
