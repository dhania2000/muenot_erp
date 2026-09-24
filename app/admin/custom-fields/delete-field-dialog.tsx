"use client"

import { useState } from "react"
import type { FieldDefinition } from "@/lib/custom-fields/model"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

/**
 * Confirm deletion of a field definition. The server refuses when a formula
 * still depends on the field, and that reason is surfaced here.
 */
export function DeleteFieldDialog({
  field,
  onClose,
  onDeleted,
}: {
  field: FieldDefinition
  onClose: () => void
  onDeleted: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch(
        `/api/admin/custom-fields/${encodeURIComponent(field.entityType)}/${encodeURIComponent(field.key)}`,
        { method: "DELETE" },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body.error ?? "Could not delete the field.")
        return
      }
      onDeleted()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog open onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete &ldquo;{field.label}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the field definition and every value stored under it across all{" "}
            {field.entityType} records. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={submitting}>
            {submitting ? "Deleting…" : "Delete field"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
