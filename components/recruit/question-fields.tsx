"use client"

import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { JobQuestion } from "@/lib/recruit"

export type Answers = Record<string, string | string[]>

export function QuestionFields({
  questions,
  answers,
  onChange,
}: {
  questions: JobQuestion[]
  answers: Answers
  onChange: (id: string, value: string | string[]) => void
}) {
  if (questions.length === 0) return null
  return (
    <div className="flex flex-col gap-4">
      {questions.map((q) => {
        const id = String(q.id)
        const value = answers[id]
        return (
          <Field key={id}>
            <FieldLabel htmlFor={`q-${id}`}>
              {q.question}
              {q.required && <span className="text-destructive"> *</span>}
            </FieldLabel>
            {q.type === "textarea" ? (
              <Textarea id={`q-${id}`} rows={3} value={(value as string) || ""} onChange={(e) => onChange(id, e.target.value)} />
            ) : q.type === "select" || q.type === "radio" ? (
              <Select value={(value as string) || ""} onValueChange={(v) => onChange(id, v)}>
                <SelectTrigger id={`q-${id}`} className="w-full"><SelectValue placeholder="Select an option" /></SelectTrigger>
                <SelectContent>
                  {q.options.map((opt) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : q.type === "checkbox" ? (
              <div className="flex flex-col gap-2">
                {q.options.map((opt) => {
                  const arr = Array.isArray(value) ? value : []
                  const checked = arr.includes(opt)
                  return (
                    <label key={opt} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(c) =>
                          onChange(id, c === true ? [...arr, opt] : arr.filter((o) => o !== opt))
                        }
                      />
                      {opt}
                    </label>
                  )
                })}
              </div>
            ) : (
              <Input
                id={`q-${id}`}
                type={q.type === "number" ? "number" : q.type === "date" ? "date" : q.type === "file" ? "url" : "text"}
                placeholder={q.type === "file" ? "Paste a link to your file" : undefined}
                value={(value as string) || ""}
                onChange={(e) => onChange(id, e.target.value)}
              />
            )}
          </Field>
        )
      })}
    </div>
  )
}
