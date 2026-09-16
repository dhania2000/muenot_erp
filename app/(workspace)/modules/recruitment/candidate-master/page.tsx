import { redirect } from "next/navigation"

// Candidate Master has been consolidated into Candidate Database, which is the
// single canonical registry backed by the recruitment_candidates table. This
// route is kept only to redirect any old bookmarks to the surviving page.
export default function Page() {
  redirect("/modules/recruitment/candidate-database")
}
