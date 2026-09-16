import { OperationsFeaturePage } from "@/components/operations/operations-feature-page"
// Task Board is an alternate lens over the same Tasks pipeline — it intentionally
// reuses the `tasks` records instead of creating a duplicate data source.
export default function TaskBoardPage() { return <OperationsFeaturePage module="tasks" /> }
