import { OperationsMeetingDetailClient } from "@/components/operations/operations-meeting-detail-client"

export default async function MeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <OperationsMeetingDetailClient meetingId={id} />
}
