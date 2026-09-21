"use client"

import { useEffect, useState } from "react"
import { Pencil, Plus, Tag, Trash2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  type ClassificationLevel,
  type ClassificationMapping,
  deleteClassificationMapping,
  listClassificationMappings,
  subscribeGovernance,
  upsertClassificationMapping,
} from "@/lib/governance-store"

const LEVELS: { level: ClassificationLevel; tone: "secondary" | "outline" | "destructive"; description: string }[] = [
  { level: "Public", tone: "secondary", description: "No restriction. Safe for any audience." },
  { level: "Internal", tone: "outline", description: "Employees only. Not for external sharing." },
  { level: "Confidential", tone: "outline", description: "Restricted to a defined business need." },
  { level: "Restricted", tone: "destructive", description: "Named roles only, logged access." },
  { level: "Highly Restricted", tone: "destructive", description: "Named individuals only, dual control." },
]

function levelTone(level: string): "secondary" | "outline" | "destructive" {
  return LEVELS.find((l) => l.level === level)?.tone ?? "outline"
}

function emptyDraft(): Omit<ClassificationMapping, "id" | "createdAt"> {
  return { module: "", entity: "", field: "", level: "Internal" }
}

export function ClassificationEditor() {
  const [mappings, setMappings] = useState<ClassificationMapping[]>([])
  const [editing, setEditing] = useState<(Partial<ClassificationMapping> & { isNew: boolean }) | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  useEffect(() => {
    const refresh = () => setMappings(listClassificationMappings())
    refresh()
    return subscribeGovernance(refresh)
  }, [])

  function save() {
    if (!editing || !editing.module?.trim() || !editing.entity?.trim() || !editing.field?.trim()) return
    upsertClassificationMapping({
      id: editing.isNew ? undefined : editing.id,
      module: editing.module.trim(),
      entity: editing.entity.trim(),
      field: editing.field.trim(),
      level: (editing.level as ClassificationLevel) ?? "Internal",
    })
    setEditing(null)
  }

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-5">
        {LEVELS.map((l) => (
          <Card key={l.level}>
            <CardContent className="flex flex-col gap-1.5 pt-4">
              <Badge variant={l.tone} className="w-fit text-[10px]">
                {l.level}
              </Badge>
              <p className="text-xs text-muted-foreground">{l.description}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-4 border-b sm:flex-row sm:items-end sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Tag className="size-4 text-muted-foreground" />
              Classification mappings
            </CardTitle>
            <CardDescription>
              Maps a module / entity / field combination to a sensitivity level. Spec 69 — frontend-only; enforcement
              still needs a backend.
            </CardDescription>
          </div>
          <Button size="sm" className="gap-1.5" onClick={() => setEditing({ ...emptyDraft(), isNew: true })}>
            <Plus className="size-3.5" />
            New mapping
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Field</TableHead>
                <TableHead>Classification</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {mappings.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">
                      {m.module}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm">{m.entity}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{m.field}</TableCell>
                  <TableCell>
                    <Badge variant={levelTone(m.level)} className="text-[10px]">
                      {m.level}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${m.field}`}
                        onClick={() => setEditing({ ...m, isNew: false })}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${m.field}`}
                        onClick={() => setDeletingId(m.id)}
                      >
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.isNew ? "New mapping" : "Edit mapping"}</DialogTitle>
            <DialogDescription>Assign a sensitivity level to a field.</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="cm-module">Module</Label>
                <Input
                  id="cm-module"
                  value={editing.module ?? ""}
                  onChange={(e) => setEditing({ ...editing, module: e.target.value })}
                  placeholder="e.g. HR"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cm-entity">Entity</Label>
                <Input
                  id="cm-entity"
                  value={editing.entity ?? ""}
                  onChange={(e) => setEditing({ ...editing, entity: e.target.value })}
                  placeholder="e.g. Employee"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cm-field">Field</Label>
                <Input
                  id="cm-field"
                  value={editing.field ?? ""}
                  onChange={(e) => setEditing({ ...editing, field: e.target.value })}
                  placeholder="e.g. Bank account number"
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="cm-level">Classification</Label>
                <Select
                  value={editing.level ?? "Internal"}
                  onValueChange={(v) => setEditing({ ...editing, level: v as ClassificationLevel })}
                >
                  <SelectTrigger id="cm-level" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((l) => (
                      <SelectItem key={l.level} value={l.level}>
                        {l.level}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save}>Save mapping</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deletingId !== null} onOpenChange={(open) => !open && setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this mapping?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deletingId) deleteClassificationMapping(deletingId)
                setDeletingId(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
