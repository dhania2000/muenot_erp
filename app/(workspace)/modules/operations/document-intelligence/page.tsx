import type { Metadata } from "next"
import { DocIntelClient } from "@/components/ai/document-intelligence/doc-intel-client"

export const metadata: Metadata = {
  title: "AI Document Intelligence",
  description:
    "Extract invoice, receipt, resume and contract fields from scanned documents with source highlights, confidence and human review before posting.",
}

export default function DocumentIntelligencePage() {
  return <DocIntelClient />
}
