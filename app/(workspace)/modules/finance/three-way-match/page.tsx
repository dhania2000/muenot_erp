import { ThreeWayMatchClient } from "@/components/finance/three-way-match-client"

// Spec37 (#201) — Purchase three-way matching. The interactive review surface:
// list + comparison evidence + tolerance config + authorised-checker resolve.
export default function ThreeWayMatchPage() {
  return <ThreeWayMatchClient />
}
