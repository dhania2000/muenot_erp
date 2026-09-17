import type React from "react"
import {
  Mail,
  MessageCircle,
  Clock,
  GitBranch,
  Tag,
  TagsIcon,
  Users,
  UserMinus,
  UserCog,
  Bell,
  ListTodo,
  Target,
  CircleStop,
  UserPlus,
  FileText,
  Sparkles,
  MousePointerClick,
} from "lucide-react"

export type StepType =
  | "email"
  | "whatsapp"
  | "wait"
  | "branch"
  | "add_tag"
  | "remove_tag"
  | "add_segment"
  | "remove_segment"
  | "assign_owner"
  | "notification"
  | "create_task"
  | "goal"
  | "end"

export type TriggerType =
  | "contact_added"
  | "tag_added"
  | "segment_entered"
  | "form_submitted"
  | "lead_created"
  | "manual"

type IconType = React.ComponentType<{ className?: string }>

export const STEP_META: Record<
  StepType,
  { label: string; icon: IconType; description: string; group: "Messaging" | "Timing" | "Data" | "Flow" }
> = {
  email: { label: "Send Email", icon: Mail, description: "Send a marketing email using a template or custom copy.", group: "Messaging" },
  whatsapp: { label: "Send WhatsApp", icon: MessageCircle, description: "Send an approved WhatsApp template or text message.", group: "Messaging" },
  wait: { label: "Wait", icon: Clock, description: "Pause the contact for a set duration before continuing.", group: "Timing" },
  branch: { label: "Branch", icon: GitBranch, description: "Split the path based on a condition (tag, field, engagement).", group: "Flow" },
  add_tag: { label: "Add Tag", icon: Tag, description: "Apply a tag to the contact.", group: "Data" },
  remove_tag: { label: "Remove Tag", icon: TagsIcon, description: "Remove a tag from the contact.", group: "Data" },
  add_segment: { label: "Add to Segment", icon: Users, description: "Add the contact to a marketing segment.", group: "Data" },
  remove_segment: { label: "Remove from Segment", icon: UserMinus, description: "Remove the contact from a marketing segment.", group: "Data" },
  assign_owner: { label: "Assign Owner", icon: UserCog, description: "Set the contact owner to a team member.", group: "Data" },
  notification: { label: "Notify Team", icon: Bell, description: "Send an internal notification to a team member.", group: "Data" },
  create_task: { label: "Create Task", icon: ListTodo, description: "Create an internal follow-up task.", group: "Data" },
  goal: { label: "Goal Checkpoint", icon: Target, description: "Mark the goal as reached when a condition is met.", group: "Flow" },
  end: { label: "End Journey", icon: CircleStop, description: "Complete the journey for the contact.", group: "Flow" },
}

export const STEP_ORDER: StepType[] = [
  "email",
  "whatsapp",
  "wait",
  "branch",
  "add_tag",
  "remove_tag",
  "add_segment",
  "remove_segment",
  "assign_owner",
  "notification",
  "create_task",
  "goal",
  "end",
]

export const TRIGGER_META: Record<TriggerType, { label: string; icon: IconType; description: string }> = {
  contact_added: { label: "Contact Added", icon: UserPlus, description: "A new marketing contact is created." },
  tag_added: { label: "Tag Added", icon: Tag, description: "A specific tag is applied to a contact." },
  segment_entered: { label: "Segment Entered", icon: Users, description: "A contact joins a marketing segment." },
  form_submitted: { label: "Form Submitted", icon: FileText, description: "A contact submits a lead-generation form." },
  lead_created: { label: "Lead Created", icon: Sparkles, description: "A new sales lead is created." },
  manual: { label: "Manual", icon: MousePointerClick, description: "Contacts are enrolled by hand or in bulk." },
}

export const TRIGGER_ORDER: TriggerType[] = [
  "manual",
  "contact_added",
  "form_submitted",
  "lead_created",
  "tag_added",
  "segment_entered",
]

export const JOURNEY_STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Active: "default",
  Draft: "outline",
  Paused: "secondary",
  Completed: "secondary",
  Archived: "destructive",
}

export const ENROLLMENT_STATUS_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  Active: "default",
  Waiting: "secondary",
  Completed: "default",
  Paused: "outline",
  Exited: "outline",
  Failed: "destructive",
}

export type Lookups = {
  users: { id: number; name: string; email: string }[]
  templates: { id: number; name: string; subject: string }[]
  segments: { id: number; name: string }[]
  whatsappTemplates: { name: string; language: string; status: string }[]
  whatsappConnected: boolean
}
