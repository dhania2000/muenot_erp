"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"
import {
  GraduationCap,
  BookOpen,
  FileVideo,
  FileText,
  ClipboardCheck,
  Award,
  Plus,
  Upload,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

// ---------------------------------------------------------------------------
// Types (mirror the API payloads in app/api/hr/training/*)
// ---------------------------------------------------------------------------
type Status = "assigned" | "started" | "completed" | "overdue"
type LessonType = "video" | "document" | "text"

type Assignment = {
  id: number
  course_id: number
  course_title: string
  category: string | null
  status: Status
  effective_status: Status
  due_date: string | null
  score: number | null
  passed: boolean | null
  total_lessons: number
  done_lessons: number
  certificate_no: string | null
}

type Lesson = {
  id: number
  module_id: number | null
  title: string
  lesson_type: LessonType
  media_id: number | null
  content: string | null
  duration_seconds: number
}

type Question = {
  id: number
  question: string
  options: string[]
  points: number
  correct_index?: number
}

type CourseDetail = {
  id: number
  code: string | null
  title: string
  description: string | null
  category: string | null
  roles: string[]
  pass_score: number
  due_days: number | null
  active: boolean
  modules: { id: number; title: string }[]
  lessons: Lesson[]
  questions: Question[]
}

type CourseSummary = CourseDetail & {
  lesson_count: number
  question_count: number
  assigned_count: number
  completed_count: number
}

type MediaRow = {
  id: number
  file_name: string | null
  mime: string | null
  size: number
  access: "assigned" | "tenant"
  expires_at: string | null
  expired: boolean
  created_at: string
}

const STATUS_STYLES: Record<Status, string> = {
  assigned: "bg-muted text-muted-foreground",
  started: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  completed: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  overdue: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
}

function StatusBadge({ status }: { status: Status }) {
  return <Badge className={STATUS_STYLES[status]} variant="secondary">{status}</Badge>
}

async function postJSON(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "Request failed")
  return data
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export function TrainingClient() {
  // Manager-only endpoint; a 403 for learners simply hides the management tabs.
  const { data: courses, error: coursesError, mutate: mutateCourses } = useSWR<CourseSummary[]>(
    "/api/hr/training/courses",
    fetcher,
    { shouldRetryOnError: false },
  )
  const isManager = !coursesError && Array.isArray(courses)

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex items-start gap-4">
        <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
          <GraduationCap className="size-5" />
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Spec 38</span>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">Training Management</h1>
          <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
            Complete assigned courses, watch lessons, pass quizzes and collect certificates.
          </p>
        </div>
      </header>

      <Tabs defaultValue="learning" className="flex flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="learning">My learning</TabsTrigger>
          <TabsTrigger value="certificates">Certificates</TabsTrigger>
          {isManager && <TabsTrigger value="courses">Courses</TabsTrigger>}
          {isManager && <TabsTrigger value="media">Media library</TabsTrigger>}
        </TabsList>

        <TabsContent value="learning" className="mt-4">
          <MyLearning />
        </TabsContent>
        <TabsContent value="certificates" className="mt-4">
          <MyCertificates />
        </TabsContent>
        {isManager && (
          <TabsContent value="courses" className="mt-4">
            <CoursesManager courses={courses ?? []} mutate={mutateCourses} />
          </TabsContent>
        )}
        {isManager && (
          <TabsContent value="media" className="mt-4">
            <MediaManager />
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Learner: my assignments
// ---------------------------------------------------------------------------
function MyLearning() {
  const { data, isLoading, mutate } = useSWR<Assignment[]>("/api/hr/training/assignments", fetcher)
  const [openId, setOpenId] = useState<number | null>(null)

  if (isLoading) return <LoadingRows />
  if (!data || data.length === 0) {
    return <EmptyCard icon={BookOpen} title="No courses assigned" description="Courses assigned to you will appear here." />
  }

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {data.map((a) => {
          const pct = a.total_lessons > 0 ? Math.round((a.done_lessons / a.total_lessons) * 100) : 0
          return (
            <Card key={a.id} className="flex flex-col">
              <CardHeader className="gap-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base leading-tight">{a.course_title}</CardTitle>
                  <StatusBadge status={a.effective_status} />
                </div>
                {a.category && <CardDescription>{a.category}</CardDescription>}
              </CardHeader>
              <CardContent className="mt-auto flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>{a.done_lessons}/{a.total_lessons} lessons</span>
                    {a.due_date && <span>Due {a.due_date}</span>}
                  </div>
                  <Progress value={pct} />
                </div>
                {a.score != null && (
                  <p className="text-xs text-muted-foreground">
                    Quiz score: <span className="font-medium text-foreground">{a.score}%</span>{" "}
                    {a.passed ? "(passed)" : "(not passed)"}
                  </p>
                )}
                <Button size="sm" onClick={() => setOpenId(a.id)}>
                  {a.effective_status === "completed" ? "Review" : "Continue"}
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
      {openId != null && (
        <AssignmentDialog
          assignmentId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => mutate()}
        />
      )}
    </>
  )
}

function AssignmentDialog({ assignmentId, onClose, onChanged }: { assignmentId: number; onClose: () => void; onChanged: () => void }) {
  const { data, isLoading, mutate } = useSWR<{
    assignment: Assignment
    course: CourseDetail
    completedLessonIds: number[]
    certificate: { certificate_no: string; score: number | null } | null
  }>(`/api/hr/training/assignments/${assignmentId}`, fetcher)

  const done = new Set(data?.completedLessonIds ?? [])

  async function completeLesson(lessonId: number) {
    try {
      await postJSON(`/api/hr/training/assignments/${assignmentId}/lessons/${lessonId}`, {})
      toast.success("Lesson marked complete")
      await mutate()
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden p-0">
        {isLoading || !data ? (
          <div className="flex h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <DialogHeader className="border-b p-6 pb-4">
              <DialogTitle>{data.course.title}</DialogTitle>
              <DialogDescription>{data.course.description || "Work through each lesson, then take the quiz."}</DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[calc(90vh-8rem)]">
              <div className="flex flex-col gap-6 p-6">
                {data.certificate && (
                  <div className="flex items-center gap-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900 dark:bg-green-950">
                    <Award className="size-5 text-green-600" />
                    <div>
                      <p className="font-medium text-green-800 dark:text-green-300">Course completed</p>
                      <p className="text-green-700 dark:text-green-400">Certificate {data.certificate.certificate_no}</p>
                    </div>
                  </div>
                )}

                <section className="flex flex-col gap-3">
                  <h3 className="text-sm font-semibold">Lessons</h3>
                  {data.course.lessons.length === 0 && <p className="text-sm text-muted-foreground">No lessons in this course.</p>}
                  {data.course.lessons.map((l) => (
                    <LessonRow
                      key={l.id}
                      lesson={l}
                      done={done.has(l.id)}
                      onComplete={() => completeLesson(l.id)}
                    />
                  ))}
                </section>

                {data.course.questions.length > 0 && (
                  <>
                    <Separator />
                    <QuizSection
                      assignmentId={assignmentId}
                      questions={data.course.questions}
                      passScore={data.course.pass_score}
                      lastScore={data.assignment.score}
                      passed={data.assignment.passed}
                      onSubmitted={async () => { await mutate(); onChanged() }}
                    />
                  </>
                )}
              </div>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

const LESSON_ICON: Record<LessonType, typeof FileText> = { video: FileVideo, document: FileText, text: BookOpen }

function LessonRow({ lesson, done, onComplete }: { lesson: Lesson; done: boolean; onComplete: () => void }) {
  const [open, setOpen] = useState(false)
  const Icon = LESSON_ICON[lesson.lesson_type]
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">{lesson.title}</span>
          {done && <CheckCircle2 className="size-4 text-green-600" />}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>{open ? "Hide" : "Open"}</Button>
          {!done && <Button size="sm" onClick={onComplete}>Mark done</Button>}
        </div>
      </div>
      {open && (
        <div className="mt-3">
          {lesson.lesson_type === "text" ? (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{lesson.content || "No content."}</p>
          ) : lesson.media_id != null ? (
            <MediaViewer mediaId={lesson.media_id} type={lesson.lesson_type} />
          ) : (
            <p className="text-sm text-muted-foreground">Media unavailable.</p>
          )}
        </div>
      )}
    </div>
  )
}

function MediaViewer({ mediaId, type }: { mediaId: number; type: LessonType }) {
  const { data, error, isLoading } = useSWR<{ url: string; mime: string | null; file_name: string | null }>(
    `/api/hr/training/media/${mediaId}`,
    fetcher,
    { shouldRetryOnError: false },
  )
  if (isLoading) return <div className="flex h-24 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
        <AlertTriangle className="size-4 shrink-0" />
        <span>{(error as Error).message}</span>
      </div>
    )
  }
  if (!data) return null
  if (type === "video") {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <video src={data.url} controls className="w-full rounded-md" />
  }
  return (
    <a href={data.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-primary underline">
      <FileText className="size-4" /> Open {data.file_name || "document"}
    </a>
  )
}

function QuizSection({
  assignmentId,
  questions,
  passScore,
  lastScore,
  passed,
  onSubmitted,
}: {
  assignmentId: number
  questions: Question[]
  passScore: number
  lastScore: number | null
  passed: boolean | null
  onSubmitted: () => Promise<void>
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({})
  const [submitting, setSubmitting] = useState(false)

  async function submit() {
    if (Object.keys(answers).length < questions.length) {
      toast.error("Answer every question before submitting")
      return
    }
    setSubmitting(true)
    try {
      const res = await postJSON(`/api/hr/training/assignments/${assignmentId}/quiz`, { answers })
      if (res.result?.passed) toast.success(`Passed with ${res.result.score}%`)
      else toast.error(`Scored ${res.result?.score}% — need ${passScore}% to pass`)
      await onSubmitted()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><ClipboardCheck className="size-4" /> Quiz</h3>
        <span className="text-xs text-muted-foreground">Pass mark {passScore}%</span>
      </div>
      {lastScore != null && (
        <p className="text-xs text-muted-foreground">
          Last attempt: <span className="font-medium text-foreground">{lastScore}%</span> {passed ? "(passed)" : "(not passed)"}
        </p>
      )}
      {questions.map((q, i) => (
        <div key={q.id} className="flex flex-col gap-2">
          <p className="text-sm font-medium">{i + 1}. {q.question}</p>
          <div className="flex flex-col gap-1.5">
            {q.options.map((opt, idx) => (
              <label key={idx} className="flex cursor-pointer items-center gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:checked]:bg-accent">
                <input
                  type="radio"
                  name={`q-${q.id}`}
                  className="accent-primary"
                  checked={answers[String(q.id)] === idx}
                  onChange={() => setAnswers((a) => ({ ...a, [String(q.id)]: idx }))}
                />
                {opt}
              </label>
            ))}
          </div>
        </div>
      ))}
      <Button onClick={submit} disabled={submitting} className="self-start">
        {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
        Submit quiz
      </Button>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Learner: certificates
// ---------------------------------------------------------------------------
function MyCertificates() {
  const { data, isLoading } = useSWR<{ id: number; course_title: string; certificate_no: string; score: number | null; issued_at: string }[]>(
    "/api/hr/training/certificates",
    fetcher,
  )
  if (isLoading) return <LoadingRows />
  if (!data || data.length === 0) {
    return <EmptyCard icon={Award} title="No certificates yet" description="Complete a course to earn a certificate." />
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {data.map((c) => (
        <Card key={c.id}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Award className="size-5 text-amber-500" />
              <CardTitle className="text-base">{c.course_title}</CardTitle>
            </div>
            <CardDescription>{c.certificate_no}</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {c.score != null && <p>Score: {c.score}%</p>}
            <p>Issued {new Date(c.issued_at).toLocaleDateString()}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Manager: courses
// ---------------------------------------------------------------------------
function CoursesManager({ courses, mutate }: { courses: CourseSummary[]; mutate: () => void }) {
  const [detailId, setDetailId] = useState<number | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Courses</h2>
        <CreateCourseDialog onCreated={mutate} />
      </div>
      {courses.length === 0 ? (
        <EmptyCard icon={BookOpen} title="No courses yet" description="Create a course to add lessons, quizzes and assignments." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {courses.map((c) => (
            <Card key={c.id} className="flex flex-col">
              <CardHeader className="gap-1">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base leading-tight">{c.title}</CardTitle>
                  {!c.active && <Badge variant="outline">inactive</Badge>}
                </div>
                <CardDescription>{c.category || "Uncategorized"}</CardDescription>
              </CardHeader>
              <CardContent className="mt-auto flex flex-col gap-3 text-xs text-muted-foreground">
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>{c.lesson_count} lessons</span>
                  <span>{c.question_count} questions</span>
                  <span>{c.assigned_count} assigned</span>
                  <span>{c.completed_count} completed</span>
                </div>
                <Button size="sm" variant="outline" onClick={() => setDetailId(c.id)}>Manage</Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {detailId != null && (
        <CourseDetailDialog courseId={detailId} onClose={() => setDetailId(null)} onChanged={mutate} />
      )}
    </div>
  )
}

function CreateCourseDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ title: "", category: "", description: "", pass_score: "70", due_days: "", roles: "" })
  const [saving, setSaving] = useState(false)

  async function submit() {
    setSaving(true)
    try {
      await postJSON("/api/hr/training/courses", {
        title: form.title,
        category: form.category || null,
        description: form.description || null,
        pass_score: Number(form.pass_score) || 70,
        due_days: form.due_days ? Number(form.due_days) : null,
        roles: form.roles.split(",").map((r) => r.trim()).filter(Boolean),
      })
      toast.success("Course created")
      setOpen(false)
      setForm({ title: "", category: "", description: "", pass_score: "70", due_days: "", roles: "" })
      onCreated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm"><Plus className="mr-2 size-4" /> New course</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New course</DialogTitle>
          <DialogDescription>Add the basics; lessons and quizzes come next.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label="Title"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Category"><Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} /></Field>
          <Field label="Description"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Pass score %"><Input type="number" value={form.pass_score} onChange={(e) => setForm({ ...form, pass_score: e.target.value })} /></Field>
            <Field label="Due in (days)"><Input type="number" value={form.due_days} onChange={(e) => setForm({ ...form, due_days: e.target.value })} placeholder="none" /></Field>
          </div>
          <Field label="Roles (comma separated, blank = everyone)">
            <Input value={form.roles} onChange={(e) => setForm({ ...form, roles: e.target.value })} placeholder="e.g. Manager, Engineer" />
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={saving || !form.title.trim()}>
            {saving && <Loader2 className="mr-2 size-4 animate-spin" />} Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CourseDetailDialog({ courseId, onClose, onChanged }: { courseId: number; onClose: () => void; onChanged: () => void }) {
  const { data: course, mutate } = useSWR<CourseDetail>(`/api/hr/training/courses/${courseId}`, fetcher)
  const { data: media } = useSWR<MediaRow[]>("/api/hr/training/media", fetcher, { shouldRetryOnError: false })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-hidden p-0">
        {!course ? (
          <div className="flex h-64 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            <DialogHeader className="border-b p-6 pb-4">
              <DialogTitle>{course.title}</DialogTitle>
              <DialogDescription>Add lessons and quiz questions, then assign the course.</DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[calc(90vh-8rem)]">
              <div className="flex flex-col gap-6 p-6">
                <AddLesson courseId={courseId} media={media ?? []} onAdded={mutate} />
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">Lessons ({course.lessons.length})</h3>
                  {course.lessons.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                      <Badge variant="outline">{l.lesson_type}</Badge>
                      {l.title}
                    </div>
                  ))}
                  {course.lessons.length === 0 && <p className="text-sm text-muted-foreground">No lessons yet.</p>}
                </div>
                <Separator />
                <AddQuestion courseId={courseId} onAdded={mutate} />
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">Questions ({course.questions.length})</h3>
                  {course.questions.map((q, i) => (
                    <div key={q.id} className="rounded-md border p-2 text-sm">{i + 1}. {q.question}</div>
                  ))}
                </div>
                <Separator />
                <AssignSection courseId={courseId} onAssigned={onChanged} />
                <Separator />
                <RosterSection courseId={courseId} />
              </div>
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AddLesson({ courseId, media, onAdded }: { courseId: number; media: MediaRow[]; onAdded: () => void }) {
  const [type, setType] = useState<LessonType>("text")
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [mediaId, setMediaId] = useState<string>("")
  const [saving, setSaving] = useState(false)

  async function add() {
    setSaving(true)
    try {
      await postJSON(`/api/hr/training/courses/${courseId}/content`, {
        kind: "lesson",
        title,
        lesson_type: type,
        content: type === "text" ? content : null,
        media_id: type === "text" ? null : mediaId ? Number(mediaId) : null,
      })
      toast.success("Lesson added")
      setTitle(""); setContent(""); setMediaId("")
      onAdded()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      <h3 className="text-sm font-semibold">Add lesson</h3>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Type">
          <Select value={type} onValueChange={(v) => setType(v as LessonType)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="video">Video</SelectItem>
              <SelectItem value="document">Document</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      {type === "text" ? (
        <Field label="Content"><Textarea value={content} onChange={(e) => setContent(e.target.value)} /></Field>
      ) : (
        <Field label="Media">
          <Select value={mediaId} onValueChange={setMediaId}>
            <SelectTrigger><SelectValue placeholder="Select uploaded media" /></SelectTrigger>
            <SelectContent>
              {media.filter((m) => !m.expired).map((m) => (
                <SelectItem key={m.id} value={String(m.id)}>{m.file_name || `Media #${m.id}`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
      <Button size="sm" onClick={add} disabled={saving || !title.trim() || (type !== "text" && !mediaId)} className="self-start">
        {saving && <Loader2 className="mr-2 size-4 animate-spin" />} Add lesson
      </Button>
    </div>
  )
}

function AddQuestion({ courseId, onAdded }: { courseId: number; onAdded: () => void }) {
  const [question, setQuestion] = useState("")
  const [options, setOptions] = useState(["", "", "", ""])
  const [correct, setCorrect] = useState(0)
  const [saving, setSaving] = useState(false)

  async function add() {
    const cleaned = options.map((o) => o.trim()).filter(Boolean)
    setSaving(true)
    try {
      await postJSON(`/api/hr/training/courses/${courseId}/content`, {
        kind: "question",
        question,
        options: cleaned,
        correct_index: correct,
      })
      toast.success("Question added")
      setQuestion(""); setOptions(["", "", "", ""]); setCorrect(0)
      onAdded()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
      <h3 className="text-sm font-semibold">Add quiz question</h3>
      <Field label="Question"><Input value={question} onChange={(e) => setQuestion(e.target.value)} /></Field>
      <div className="flex flex-col gap-2">
        <Label className="text-xs">Options (select the correct one)</Label>
        {options.map((opt, i) => (
          <div key={i} className="flex items-center gap-2">
            <input type="radio" name="correct" className="accent-primary" checked={correct === i} onChange={() => setCorrect(i)} />
            <Input value={opt} onChange={(e) => setOptions(options.map((o, j) => (j === i ? e.target.value : o)))} placeholder={`Option ${i + 1}`} />
          </div>
        ))}
      </div>
      <Button size="sm" onClick={add} disabled={saving || !question.trim() || options.filter((o) => o.trim()).length < 2} className="self-start">
        {saving && <Loader2 className="mr-2 size-4 animate-spin" />} Add question
      </Button>
    </div>
  )
}

function AssignSection({ courseId, onAssigned }: { courseId: number; onAssigned: () => void }) {
  const [roles, setRoles] = useState("")
  const [reassign, setReassign] = useState(false)
  const [saving, setSaving] = useState(false)

  async function assign() {
    setSaving(true)
    try {
      const res = await postJSON(
        `/api/hr/training/courses/${courseId}/assign`,
        { roles: roles.split(",").map((r) => r.trim()).filter(Boolean), reassign },
        { "idempotency-key": `assign-${courseId}-${Date.now()}` },
      )
      toast.success(`Assigned ${res.assigned}, reassigned ${res.reassigned}, skipped ${res.skipped}`)
      onAssigned()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Users className="size-4" /> Assign course</h3>
      <Field label="Roles (comma separated, blank = course default / everyone)">
        <Input value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="e.g. Engineer, Manager" />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={reassign} onCheckedChange={(v) => setReassign(!!v)} />
        Reassign (restart progress for people already assigned)
      </label>
      <Button size="sm" onClick={assign} disabled={saving} className="self-start">
        {saving && <Loader2 className="mr-2 size-4 animate-spin" />} Assign
      </Button>
    </div>
  )
}

function RosterSection({ courseId }: { courseId: number }) {
  const { data } = useSWR<Assignment[]>(`/api/hr/training/courses/${courseId}/assignments`, fetcher)
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">Assignments ({data?.length ?? 0})</h3>
      {data && data.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Employee</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Score</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((a: any) => (
              <TableRow key={a.id}>
                <TableCell>{a.employee_name || `#${a.employee_id}`}</TableCell>
                <TableCell><StatusBadge status={a.effective_status} /></TableCell>
                <TableCell>{a.done_lessons}/{a.total_lessons}</TableCell>
                <TableCell>{a.score != null ? `${a.score}%` : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">No one assigned yet.</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Manager: media library
// ---------------------------------------------------------------------------
function MediaManager() {
  const { data, isLoading, mutate } = useSWR<MediaRow[]>("/api/hr/training/media", fetcher)
  const [uploading, setUploading] = useState(false)
  const [access, setAccess] = useState<"assigned" | "tenant">("assigned")
  const [expires, setExpires] = useState("")

  async function upload(file: File) {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      fd.append("access", access)
      if (expires) fd.append("expires_at", expires)
      const res = await fetch("/api/hr/training/media", { method: "POST", body: fd })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Upload failed")
      toast.success("Media uploaded")
      mutate()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload media</CardTitle>
          <CardDescription>Videos and documents are stored in central private storage with access control.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Access">
              <Select value={access} onValueChange={(v) => setAccess(v as "assigned" | "tenant")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="assigned">Assigned learners only</SelectItem>
                  <SelectItem value="tenant">All employees</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Expires (optional)"><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
          </div>
          <div>
            <input
              id="media-file"
              type="file"
              className="hidden"
              accept="video/*,application/pdf,.doc,.docx,.ppt,.pptx,.txt"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = "" }}
            />
            <Button size="sm" disabled={uploading} onClick={() => document.getElementById("media-file")?.click()}>
              {uploading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />} Choose file
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <LoadingRows />
      ) : !data || data.length === 0 ? (
        <EmptyCard icon={FileVideo} title="No media" description="Upload videos or documents for your lessons." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.file_name || `Media #${m.id}`}</TableCell>
                <TableCell>{m.access === "tenant" ? "All employees" : "Assigned"}</TableCell>
                <TableCell>{m.expires_at ? new Date(m.expires_at).toLocaleDateString() : "—"}</TableCell>
                <TableCell>{m.expired ? <Badge variant="destructive">expired</Badge> : <Badge variant="secondary">active</Badge>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}

function EmptyCard({ icon: Icon, title, description }: { icon: typeof BookOpen; title: string; description: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border bg-card p-12 text-center">
      <span className="inline-flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Icon className="size-5" /></span>
      <p className="font-medium">{title}</p>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

function LoadingRows() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-40 animate-pulse rounded-xl border bg-muted/40" />
      ))}
    </div>
  )
}
