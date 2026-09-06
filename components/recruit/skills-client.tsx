"use client"

import { useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { Card, CardContent } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Loader2, Plus, Tag, Trash2 } from "lucide-react"
import { PageHeader } from "@/components/recruit/recruit-shared"
import { formatDate } from "@/lib/recruit"

type Skill = { skill_id: string; name: string; created_at: string }

export function SkillsClient({ canManage }: { canManage: boolean }) {
  const { data, isLoading, mutate } = useSWR<{ skills: Skill[] }>("/api/recruit/skills", fetcher)
  const [name, setName] = useState("")
  const [loading, setLoading] = useState(false)
  const skills = data?.skills ?? []

  async function add(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    const res = await fetch("/api/recruit/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
    setLoading(false)
    if (res.ok) { toast.success("Skill added"); setName(""); mutate() }
    else {
      const body = await res.json().catch(() => ({}))
      toast.error(body.error || "Unable to add skill")
    }
  }

  async function remove(id: string) {
    const res = await fetch(`/api/recruit/skills/${id}`, { method: "DELETE" })
    if (res.ok) { toast.success("Skill removed"); mutate() } else toast.error("Unable to remove skill")
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Job Skills" description="Maintain the master list of skills used across your job postings." icon={Tag} />

      {canManage && (
        <Card>
          <CardContent>
            <form onSubmit={add} className="flex items-end gap-3">
              <Field className="flex-1">
                <FieldLabel htmlFor="skill">New skill</FieldLabel>
                <Input id="skill" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TypeScript" />
              </Field>
              <Button type="submit" disabled={loading}>
                {loading ? <Loader2 className="size-4 animate-spin" data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
                Add skill
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Skill</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Added</TableHead>
              {canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && <TableRow><TableCell colSpan={canManage ? 4 : 3} className="py-10 text-center text-sm text-muted-foreground">Loading skills...</TableCell></TableRow>}
            {!isLoading && skills.length === 0 && <TableRow><TableCell colSpan={canManage ? 4 : 3} className="py-10 text-center text-sm text-muted-foreground">No skills added yet.</TableCell></TableRow>}
            {skills.map((s) => (
              <TableRow key={s.skill_id}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell className="text-muted-foreground">{s.skill_id}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(s.created_at)}</TableCell>
                {canManage && (
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon-sm" aria-label="Delete skill" onClick={() => remove(s.skill_id)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </main>
  )
}
