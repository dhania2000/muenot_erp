import { describe, it, expect } from "vitest"
import {
  evaluateSodApproval,
  evaluateBudget,
  evaluatePoChain,
  evaluateGrnChain,
  evaluateRfqAward,
  evaluateRfqSelection,
  evaluateRfqCancellation,
  evaluateRequisitionCancellation,
  evaluatePoCancellation,
  evaluateApprovalTransition,
  evaluateApprovedImmutability,
  evaluatePoAgainstUpstream,
  evaluateGrnQuantities,
  evaluateGrnSod,
  evaluateBillAgainstPo,
  evaluateBillPayment,
  evaluateProcurementDelete,
  derivePoFulfilmentStatus,
} from "@/lib/finance-procurement-rules"

describe("evaluateSodApproval", () => {
  it("blocks the creator from approving their own document", () => {
    expect(
      evaluateSodApproval({ actorUserId: 7, creatorUserId: 7, prevStatus: "Submitted", nextStatus: "Approved" }),
    ).toMatch(/[Ss]egregation of duties/)
  })
  it("allows a different approver", () => {
    expect(
      evaluateSodApproval({ actorUserId: 8, creatorUserId: 7, prevStatus: "Submitted", nextStatus: "Approved" }),
    ).toBeNull()
  })
  it("ignores non-approval edits", () => {
    expect(
      evaluateSodApproval({ actorUserId: 7, creatorUserId: 7, prevStatus: "Draft", nextStatus: "Submitted" }),
    ).toBeNull()
  })
  it("does not re-gate an already approved document", () => {
    expect(
      evaluateSodApproval({ actorUserId: 7, creatorUserId: 7, prevStatus: "Approved", nextStatus: "Approved" }),
    ).toBeNull()
  })
})

describe("evaluateBudget", () => {
  it("rejects an approval over the remaining budget", () => {
    const d = evaluateBudget({ amount: 500, budgetedAmount: 1000, actualAmount: 400, committedAmount: 200, budgetFound: true })
    expect(d.ok).toBe(false)
    expect(d.available).toBe(400)
    expect(d.message).toMatch(/Budget limit exceeded/)
  })
  it("allows an approval within budget", () => {
    const d = evaluateBudget({ amount: 300, budgetedAmount: 1000, actualAmount: 400, committedAmount: 200, budgetFound: true })
    expect(d.ok).toBe(true)
    expect(d.message).toBeNull()
  })
  it("skips the check when no budget is on file", () => {
    const d = evaluateBudget({ amount: 999999, budgetedAmount: 0, budgetFound: false })
    expect(d.ok).toBe(true)
    expect(d.available).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("evaluatePoChain", () => {
  it("blocks a PO citing an unapproved requisition", () => {
    expect(
      evaluatePoChain({ requisitionRef: "PR-1", requisition: { approval_status: "Submitted" }, rfq: null }),
    ).toMatch(/not approved/)
  })
  it("blocks a PO citing a missing requisition", () => {
    expect(evaluatePoChain({ requisitionRef: "PR-9", requisition: null, rfq: null })).toMatch(/does not exist/)
  })
  it("blocks a PO citing an un-awarded RFQ", () => {
    expect(evaluatePoChain({ rfqRef: "RFQ-1", rfq: { status: "Draft" }, requisition: null })).toMatch(/not been awarded/)
  })
  it("allows a fully cleared chain", () => {
    expect(
      evaluatePoChain({
        requisitionRef: "PR-1",
        requisition: { approval_status: "Approved" },
        rfqRef: "RFQ-1",
        rfq: { status: "Awarded" },
      }),
    ).toBeNull()
  })
})

describe("evaluateGrnChain", () => {
  it("requires a PO reference", () => {
    expect(evaluateGrnChain({ poRef: "", po: null, receivedQuantity: 10 })).toMatch(/must reference/)
  })
  it("blocks receipt against an unapproved PO", () => {
    expect(
      evaluateGrnChain({ poRef: "PO-1", po: { approval_status: "Submitted", status: "Submitted" }, receivedQuantity: 10 }),
    ).toMatch(/not approved/)
  })
  it("blocks receipt against a cancelled PO", () => {
    expect(
      evaluateGrnChain({ poRef: "PO-1", po: { approval_status: "Approved", status: "Cancelled" }, receivedQuantity: 10 }),
    ).toMatch(/cancelled/)
  })
  it("requires a positive received quantity", () => {
    expect(
      evaluateGrnChain({ poRef: "PO-1", po: { approval_status: "Approved", status: "Approved" }, receivedQuantity: 0 }),
    ).toMatch(/greater than zero/)
  })
  it("allows a valid receipt", () => {
    expect(
      evaluateGrnChain({ poRef: "PO-1", po: { approval_status: "Approved", status: "Approved" }, receivedQuantity: 5 }),
    ).toBeNull()
  })
})

describe("derivePoFulfilmentStatus", () => {
  it("stays Approved with nothing received", () => {
    expect(derivePoFulfilmentStatus(100, 0, "Approved")).toBe("Approved")
  })
  it("becomes Partially Received", () => {
    expect(derivePoFulfilmentStatus(100, 40, "Approved")).toBe("Partially Received")
  })
  it("becomes Received when fully delivered", () => {
    expect(derivePoFulfilmentStatus(100, 100, "Approved")).toBe("Received")
  })
  it("never resurrects a cancelled PO", () => {
    expect(derivePoFulfilmentStatus(100, 100, "Cancelled")).toBe("Cancelled")
  })
})

describe("evaluateRfqAward", () => {
  it("blocks awarding with no quotes", () => {
    expect(evaluateRfqAward("Awarded", 0)).toMatch(/at least one vendor quote/)
  })
  it("allows awarding with quotes", () => {
    expect(evaluateRfqAward("Awarded", 2)).toBeNull()
  })
})

describe("evaluateRfqSelection", () => {
  it("requires the awarded vendor to have quoted", () => {
    expect(
      evaluateRfqSelection({ status: "Awarded", selected_vendor_name: "Ghost", vendor_1_name: "Alpha", vendor_1_quote: 100 }),
    ).toMatch(/must be one of the vendors/)
  })
  it("passes when the awarded vendor quoted", () => {
    expect(
      evaluateRfqSelection({ status: "Awarded", selected_vendor_name: "Alpha", vendor_1_name: "Alpha", vendor_1_quote: 100 }),
    ).toBeNull()
  })
})

describe("cancellation rules", () => {
  it("blocks cancelling a requisition with linked POs", () => {
    expect(evaluateRequisitionCancellation("Cancelled", { linkedPoCount: 1 })).toMatch(/purchase order/)
  })
  it("allows cancelling a requisition with no POs", () => {
    expect(evaluateRequisitionCancellation("Cancelled", { linkedPoCount: 0 })).toBeNull()
  })
  it("blocks cancelling a PO with receipts", () => {
    expect(evaluatePoCancellation("Cancelled", { grnCount: 1, billCount: 0 })).toMatch(/goods receipt/)
  })
  it("blocks cancelling a PO with bills", () => {
    expect(evaluatePoCancellation("Cancelled", { grnCount: 0, billCount: 2 })).toMatch(/vendor bill/)
  })
  it("allows cancelling a clean PO", () => {
    expect(evaluatePoCancellation("Cancelled", { grnCount: 0, billCount: 0 })).toBeNull()
  })
  it("blocks cancelling an RFQ with linked POs", () => {
    expect(evaluateRfqCancellation("Cancelled", { linkedPoCount: 1 })).toMatch(/purchase order/)
  })
})

describe("evaluateApprovalTransition", () => {
  it("forbids creating a document already Approved", () => {
    expect(evaluateApprovalTransition(null, "Approved", { isCreate: true })).toMatch(/cannot be created/)
  })
  it("allows creating as Draft or Submitted", () => {
    expect(evaluateApprovalTransition(null, "Submitted", { isCreate: true })).toBeNull()
  })
  it("forbids walking back an approved document", () => {
    expect(evaluateApprovalTransition("Approved", "Draft", { isCreate: false })).toMatch(/Invalid approval transition/)
  })
  it("allows Submitted → Approved", () => {
    expect(evaluateApprovalTransition("Submitted", "Approved", { isCreate: false })).toBeNull()
  })
})

describe("evaluateApprovedImmutability", () => {
  it("blocks changing a locked field once approved", () => {
    expect(
      evaluateApprovedImmutability({ approval_status: "Approved", total_amount: 1000 }, { total_amount: 1200 }, ["total_amount"]),
    ).toMatch(/can no longer be changed/)
  })
  it("allows edits before approval", () => {
    expect(
      evaluateApprovedImmutability({ approval_status: "Draft", total_amount: 1000 }, { total_amount: 1200 }, ["total_amount"]),
    ).toBeNull()
  })
  it("ignores an unchanged locked field", () => {
    expect(
      evaluateApprovedImmutability({ approval_status: "Approved", total_amount: 1000 }, { total_amount: 1000 }, ["total_amount"]),
    ).toBeNull()
  })
})

describe("evaluatePoAgainstUpstream", () => {
  it("rejects a non-positive quantity", () => {
    expect(evaluatePoAgainstUpstream({ poQuantity: 0, poTaxable: 0 })).toMatch(/greater than zero/)
  })
  it("blocks over-ordering against the requisition", () => {
    expect(
      evaluatePoAgainstUpstream({ poQuantity: 80, poTaxable: 0, requisition: { quantity: 100 }, otherOrderedQuantity: 40 }),
    ).toMatch(/exceeds the requisition/)
  })
  it("blocks a vendor other than the awarded RFQ vendor", () => {
    expect(
      evaluatePoAgainstUpstream({
        poQuantity: 10,
        poTaxable: 100,
        poVendorName: "Other",
        rfq: { selected_vendor_name: "Alpha", awarded_amount: 1000 },
      }),
    ).toMatch(/awarded vendor/)
  })
  it("blocks a PO priced above the awarded quote", () => {
    expect(
      evaluatePoAgainstUpstream({
        poQuantity: 10,
        poTaxable: 1500,
        poVendorName: "Alpha",
        rfq: { selected_vendor_name: "Alpha", awarded_amount: 1000 },
      }),
    ).toMatch(/exceeds the awarded quote/)
  })
  it("allows a consistent PO", () => {
    expect(
      evaluatePoAgainstUpstream({
        poQuantity: 10,
        poTaxable: 900,
        poVendorName: "Alpha",
        requisition: { quantity: 100 },
        otherOrderedQuantity: 0,
        rfq: { selected_vendor_name: "Alpha", awarded_amount: 1000 },
      }),
    ).toBeNull()
  })
})

describe("evaluateGrnQuantities", () => {
  it("rejects negative quantities", () => {
    expect(
      evaluateGrnQuantities({ orderedQuantity: 100, alreadyReceived: 0, receivedQuantity: -1, acceptedQuantity: 0, rejectedQuantity: 0 }),
    ).toMatch(/cannot be negative/)
  })
  it("rejects accepted+rejected exceeding received", () => {
    expect(
      evaluateGrnQuantities({ orderedQuantity: 100, alreadyReceived: 0, receivedQuantity: 10, acceptedQuantity: 8, rejectedQuantity: 5 }),
    ).toMatch(/cannot exceed the received/)
  })
  it("blocks receipt beyond the ordered quantity + tolerance", () => {
    expect(
      evaluateGrnQuantities({ orderedQuantity: 100, alreadyReceived: 90, receivedQuantity: 20, acceptedQuantity: 20, rejectedQuantity: 0 }),
    ).toMatch(/exceeds the purchase order/)
  })
  it("permits within tolerance", () => {
    expect(
      evaluateGrnQuantities({
        orderedQuantity: 100,
        alreadyReceived: 90,
        receivedQuantity: 15,
        acceptedQuantity: 15,
        rejectedQuantity: 0,
        overReceiptTolerancePercent: 10,
      }),
    ).toBeNull()
  })
})

describe("evaluateGrnSod", () => {
  it("blocks the PO approver from receiving", () => {
    expect(evaluateGrnSod(5, 5)).toMatch(/[Ss]egregation of duties/)
  })
  it("allows a different receiver", () => {
    expect(evaluateGrnSod(6, 5)).toBeNull()
  })
  it("no-ops when the approver is unknown", () => {
    expect(evaluateGrnSod(6, null)).toBeNull()
  })
})

describe("evaluateBillAgainstPo", () => {
  const base = {
    poRef: "PO-1",
    po: { approval_status: "Approved", status: "Approved", vendor_id: "V1", vendor_name: "Alpha", gst_rate: 18 },
    billVendorId: "V1",
    billTaxable: 500,
    billGstRate: 18,
    receivedValue: 1000,
    otherBilledTaxable: 0,
    grnCount: 1,
  }
  it("blocks a bill against a missing PO", () => {
    expect(evaluateBillAgainstPo({ ...base, po: null })).toMatch(/does not exist/)
  })
  it("blocks a bill when no goods were received", () => {
    expect(evaluateBillAgainstPo({ ...base, grnCount: 0 })).toMatch(/no goods have been received/)
  })
  it("blocks a vendor mismatch", () => {
    expect(evaluateBillAgainstPo({ ...base, billVendorId: "V2", billVendorName: "Beta" })).toMatch(/does not match/)
  })
  it("blocks a GST rate mismatch (tax check)", () => {
    expect(evaluateBillAgainstPo({ ...base, billGstRate: 12 })).toMatch(/GST rate/)
  })
  it("blocks over-billing beyond the received-but-unbilled value", () => {
    expect(evaluateBillAgainstPo({ ...base, billTaxable: 1200 })).toMatch(/exceeds the received-but-unbilled/)
  })
  it("accounts for what was already billed", () => {
    expect(evaluateBillAgainstPo({ ...base, billTaxable: 600, otherBilledTaxable: 500 })).toMatch(/exceeds/)
  })
  it("allows a valid bill", () => {
    expect(evaluateBillAgainstPo(base)).toBeNull()
  })
})

describe("evaluateBillPayment", () => {
  it("rejects a negative payment", () => {
    expect(evaluateBillPayment({ amountPaid: -1, payable: 100, previousPaid: 0, chainError: null })).toMatch(/cannot be negative/)
  })
  it("rejects overpaying the bill", () => {
    expect(evaluateBillPayment({ amountPaid: 150, payable: 100, previousPaid: 0, chainError: null })).toMatch(/exceeds the bill/)
  })
  it("blocks new payment when the chain is broken", () => {
    expect(evaluateBillPayment({ amountPaid: 50, payable: 100, previousPaid: 0, chainError: "PO not approved" })).toMatch(/Payment blocked/)
  })
  it("allows a valid payment", () => {
    expect(evaluateBillPayment({ amountPaid: 50, payable: 100, previousPaid: 0, chainError: null })).toBeNull()
  })
})

describe("evaluateProcurementDelete", () => {
  it("blocks deleting an approved document", () => {
    expect(evaluateProcurementDelete({ approval_status: "Approved" }, { downstreamCount: 0, documentLabel: "purchase order" })).toMatch(/cannot be deleted/)
  })
  it("blocks deleting a document with downstream references", () => {
    expect(evaluateProcurementDelete({ approval_status: "Draft" }, { downstreamCount: 2, documentLabel: "requisition" })).toMatch(/downstream/)
  })
  it("allows deleting a clean draft", () => {
    expect(evaluateProcurementDelete({ approval_status: "Draft" }, { downstreamCount: 0, documentLabel: "requisition" })).toBeNull()
  })
})
