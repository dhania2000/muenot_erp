import { OperationsTaskBoard } from "@/components/operations/operations-task-board"

// Task Board is an alternate lens over the same Tasks pipeline — it renders the
// `tasks` records as a drag-and-drop Kanban grouped by board_stage instead of a
// duplicate table, and never creates a separate data source.
export default function TaskBoardPage() {
  return <OperationsTaskBoard />
}
