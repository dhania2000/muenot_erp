"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import type { VendorPortalItem } from "@/lib/vendor-portal/store"
import { ItemList } from "@/components/vendor-portal/item-list"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Plus, Loader2 } from "lucide-react"

export function InvoicesView({ items }: { items: VendorPortalItem[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState("")
  const [reference, setReference] = useState("")
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("INR")
  const [issueDate, setIssueDate] = useState("")
  const [dueDate, setDueDate] = useState("")
  const [description, setDescription] = useState("")

  function reset() {
    setTitle("")
    setReference("")
    setAmount("")
    setCurrency("INR")
    setIssueDate("")
    setDueDate("")
    setDescription("")
    setError(null)
  }

  async function submit() {
    if (!title.trim()) {
      setError("An invoice number or title is required")
      return
    }
    if (amount && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
      setError("Amount must be a positive number")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/vendor-portal/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          reference: reference.trim() || null,
          amount: amount || null,
          currency: currency.trim() || "INR",
          issueDate: issueDate || null,
          dueDate: dueDate || null,
          description: description.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || "Could not submit your invoice. Please try again.")
        return
      }
      setOpen(false)
      reset()
      router.refresh()
    } catch {
      setError("Could not submit your invoice. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const submitInvoiceButton = (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Submit invoice
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit an invoice</DialogTitle>
          <DialogDescription>
            Submit an invoice against your purchase orders. The accounts-payable team will review it before approval.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="inv-title">Invoice number / title</Label>
            <Input
              id="inv-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="INV-2026-001"
              required
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="inv-reference">PO reference (optional)</Label>
              <Input
                id="inv-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="PO-1024"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="inv-amount">Amount</Label>
              <div className="flex gap-2">
                <Input
                  id="inv-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 5))}
                  className="w-20"
                  aria-label="Currency"
                />
                <Input
                  id="inv-amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="flex-1"
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="inv-issue">Issue date</Label>
              <Input id="inv-issue" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="inv-due">Due date</Label>
              <Input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="inv-desc">Notes (optional)</Label>
            <Textarea
              id="inv-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Line-item summary or any notes for the AP team."
              rows={3}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={submitting || !title.trim()} className="gap-2">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Submit invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return (
    <ItemList
      resource="invoices"
      title="Invoices"
      description="Submit invoices against your purchase orders and track their approval."
      items={items}
      headerAction={submitInvoiceButton}
    />
  )
}
