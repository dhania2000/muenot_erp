"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { Card, CardContent } from "@/components/ui/card"
import { ArrowLeft, Loader2, Tag } from "lucide-react"
import { PageHeader } from "@/components/recruit/recruit-shared"

export function SkillFormClient() {
  const router = useRouter()
  const [name, setName] = useState("")
  const [loading, setLoading] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    const res = await fetch("/api/recruit/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
    setLoading(false)
    if (res.ok) {
      toast.success("Skill added")
      router.push("/modules/recruitment/job-skills")
    } else {
      const body = await res.json().catch(() => ({}))
      toast.error(body.error || "Unable to add skill")
    }
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <div>
        <Button variant="ghost" size="sm" render={<Link href="/modules/recruitment/job-skills" />}>
          <ArrowLeft data-icon="inline-start" /> Back to skills
        </Button>
      </div>
      <PageHeader title="Add Job Skill" description="Create a new skill for use across your job postings." icon={Tag} />
      <Card className="max-w-xl">
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="skill">Skill name</FieldLabel>
              <Input id="skill" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. TypeScript" autoFocus />
            </Field>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={loading}>
                {loading && <Loader2 className="size-4 animate-spin" data-icon="inline-start" />}
                Save skill
              </Button>
              <Button type="button" variant="outline" render={<Link href="/modules/recruitment/job-skills" />}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
