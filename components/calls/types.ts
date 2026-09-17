export type CallType = "audio" | "video"

export type CallStatus =
  | "calling"
  | "ringing"
  | "accepted"
  | "connecting"
  | "connected"
  | "rejected"
  | "busy"
  | "missed"
  | "ended"
  | "failed"
  | "cancelled"

export type CallPeer = {
  userId: number
  employeeId: number
  name: string
  designation: string | null
  department: string | null
  photoUrl: string | null
}

export type CallContext = {
  origin: string | null
  projectId: number | null
  projectName: string | null
  taskId: number | null
  taskName: string | null
}

export type CallView = {
  id: number
  role: "caller" | "receiver"
  status: CallStatus
  callType: CallType
  endReason: string | null
  startedAt: string | null
  answeredAt: string | null
  context: CallContext
  peer: CallPeer
  token: string
  iceServers: { urls: string | string[]; username?: string; credential?: string }[]
}

/** A reusable call target — an HR Employee Master record. */
export type CallTargetInput = {
  employeeId: number
  name?: string
  callerEmployeeId?: number | null
  origin?: string
  projectId?: number | null
  projectName?: string | null
  taskId?: number | null
  taskName?: string | null
}

export type ConnState = "connecting" | "connected" | "reconnecting"

export type UiPhase = "incoming" | "outgoing" | "active" | "ended"
