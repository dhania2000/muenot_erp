"use client"

/**
 * SPEC 84 — Saved Views: reusable toolbar.
 *
 * Renders the view switcher, save/update/delete controls, the column
 * visibility+order menu, grouping and page-size selectors. Driven entirely by
 * the `useSavedViews` hook so any table gets the same UX by passing the hook's
 * return value straight through.
 */

import { useState } from "react"
import {
  Bookmark,
  BookmarkPlus,
  Check,
  ChevronDown,
  Columns3,
  Globe,
  Lock,
  RotateCcw,
  Save,
  Trash2,
  Users,
  UserRound,
  ArrowUp,
  ArrowDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { DEFAULT_PAGE_SIZES, VIEW_VISIBILITY_LABELS } from "@/lib/saved-views/types"
import type { SavedViewRecord, ViewColumnDef, ViewVisibility } from "@/lib/saved-views/types"
import type { useSavedViews } from "./use-saved-views"

type Hook = ReturnType<typeof useSavedViews>

const VIS_ICON: Record<ViewVisibility, typeof Lock> = {
  private: Lock,
  public: Globe,
  role: UserRound,
  team: Users,
}

function labelFor(def: ViewColumnDef | undefined, key: string): string {
  return def?.label ?? key
}

export function SavedViewsBar({ hook, groupable = true }: { hook: Hook; groupable?: boolean }) {
  const {
    columns,
    views,
    activeView,
    activeViewId,
    isDirty,
    busy,
    permissions,
    roles,
    teams,
    state,
    setPageSize,
    setGroupBy,
    toggleColumn,
    moveColumn,
    applyView,
    resetToDefault,
    saveAs,
    updateActive,
    remove,
  } = hook

  const [saveOpen, setSaveOpen] = useState(false)
  const [deleting, setDeleting] = useState<SavedViewRecord | null>(null)

  const defByKey = new Map(columns.map((c) => [c.key, c]))
  const groupableCols = columns.filter((c) => c.groupable)

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* View switcher */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="gap-2">
              <Bookmark className="size-4" />
              <span className="max-w-40 truncate">{activeView ? activeView.name : "All records"}</span>
              {isDirty && <span className="size-1.5 rounded-full bg-primary" aria-label="Unsaved changes" />}
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onClick={() => applyView(null)}>
            <Check className={"size-4 " + (activeViewId == null ? "opacity-100" : "opacity-0")} />
            All records
          </DropdownMenuItem>
          {views.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuGroup>
            {views.map((v) => {
              const Icon = VIS_ICON[v.visibility]
              return (
                <DropdownMenuItem key={v.id} onClick={() => applyView(v.id)} className="gap-2">
                  <Check className={"size-4 " + (activeViewId === v.id ? "opacity-100" : "opacity-0")} />
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="flex-1 truncate">{v.name}</span>
                  {v.isDefault && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      default
                    </Badge>
                  )}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Columns menu (visibility + order) */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="sm" className="gap-2">
              <Columns3 className="size-4" /> Columns
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel>Columns</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="max-h-72 overflow-y-auto">
            {state.columns.map((c, i) => {
              const def = defByKey.get(c.key)
              return (
                <div key={c.key} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                  <Checkbox
                    id={`col-${c.key}`}
                    checked={!c.hidden}
                    onCheckedChange={() => toggleColumn(c.key)}
                  />
                  <Label htmlFor={`col-${c.key}`} className="flex-1 cursor-pointer font-normal">
                    {labelFor(def, c.key)}
                  </Label>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    aria-label={`Move ${labelFor(def, c.key)} up`}
                    disabled={i === 0}
                    onClick={() => moveColumn(c.key, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-6"
                    aria-label={`Move ${labelFor(def, c.key)} down`}
                    disabled={i === state.columns.length - 1}
                    onClick={() => moveColumn(c.key, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                </div>
              )
            })}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Grouping */}
      {groupable && groupableCols.length > 0 && (
        <Select value={state.groupBy ?? "none"} onValueChange={(v) => setGroupBy(v === "none" ? null : (v as string))}>
          <SelectTrigger size="sm" className="w-40">
            <SelectValue placeholder="Group by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            {groupableCols.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                Group: {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Page size */}
      <Select value={String(state.pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
        <SelectTrigger size="sm" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DEFAULT_PAGE_SIZES.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {n} / page
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Separator orientation="vertical" className="mx-1 h-6" />

      {/* Save / update / reset */}
      {activeView && activeView.canEdit && isDirty && (
        <Button variant="outline" size="sm" className="gap-2" disabled={busy} onClick={() => updateActive()}>
          <Save className="size-4" /> Update
        </Button>
      )}
      {isDirty && (
        <Button variant="ghost" size="sm" className="gap-2" onClick={resetToDefault}>
          <RotateCcw className="size-4" /> Reset
        </Button>
      )}
      <Button variant="default" size="sm" className="gap-2" onClick={() => setSaveOpen(true)}>
        <BookmarkPlus className="size-4" /> Save as
      </Button>

      {activeView && activeView.canEdit && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete view"
          onClick={() => setDeleting(activeView)}
        >
          <Trash2 className="size-4" />
        </Button>
      )}

      <SaveViewDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        canManageShared={permissions.canManageShared}
        roles={roles}
        teams={teams}
        busy={busy}
        onSave={async (args) => {
          const ok = await saveAs(args)
          if (ok) setSaveOpen(false)
        }}
      />

      <AlertDialog open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this view?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleting?.name}&quot; will be removed for everyone it is shared with. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleting) remove(deleting.id)
                setDeleting(null)
              }}
            >
              Delete view
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function SaveViewDialog({
  open,
  onOpenChange,
  canManageShared,
  roles,
  teams,
  busy,
  onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  canManageShared: boolean
  roles: { key: string; label: string }[]
  teams: string[]
  busy: boolean
  onSave: (args: {
    name: string
    visibility: ViewVisibility
    roleKey?: string | null
    teamKey?: string | null
    isDefault?: boolean
  }) => void
}) {
  const [name, setName] = useState("")
  const [visibility, setVisibility] = useState<ViewVisibility>("private")
  const [roleKey, setRoleKey] = useState<string>(roles[0]?.key ?? "")
  const [teamKey, setTeamKey] = useState<string>(teams[0] ?? "")
  const [isDefault, setIsDefault] = useState(false)

  const options: { value: ViewVisibility; disabled?: boolean }[] = [
    { value: "private" },
    { value: "team", disabled: teams.length === 0 && !canManageShared },
    { value: "role", disabled: !canManageShared },
    { value: "public", disabled: !canManageShared },
  ]

  function submit() {
    if (!name.trim()) return
    onSave({
      name: name.trim(),
      visibility,
      roleKey: visibility === "role" ? roleKey || null : null,
      teamKey: visibility === "team" ? teamKey || null : null,
      isDefault,
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setName("")
          setVisibility("private")
          setIsDefault(false)
        }
        onOpenChange(v)
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
          <DialogDescription>
            Save the current filters, columns, sorting and page size as a reusable view.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="view-name">View name</Label>
            <Input
              id="view-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Active enterprise clients"
            />
          </div>

          <div className="grid gap-2">
            <Label>Visibility</Label>
            <div className="grid gap-1.5">
              {options.map((opt) => {
                const Icon = VIS_ICON[opt.value]
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={opt.disabled}
                    onClick={() => setVisibility(opt.value)}
                    className={
                      "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
                      (visibility === opt.value
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50")
                    }
                  >
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="flex-1">{VIEW_VISIBILITY_LABELS[opt.value]}</span>
                    {visibility === opt.value && <Check className="size-4 text-primary" />}
                  </button>
                )
              })}
            </div>
            {!canManageShared && (
              <p className="text-xs text-muted-foreground">
                Only tenant admins can share views with a role or the whole tenant.
              </p>
            )}
          </div>

          {visibility === "role" && (
            <div className="grid gap-2">
              <Label>Role</Label>
              <Select value={roleKey} onValueChange={(v) => setRoleKey(v as string)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((r) => (
                    <SelectItem key={r.key} value={r.key}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {visibility === "team" && (
            <div className="grid gap-2">
              <Label>Team</Label>
              {teams.length > 0 ? (
                <Select value={teamKey} onValueChange={(v) => setTeamKey(v as string)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a team" />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-muted-foreground">
                  You are not a member of any team, so there is no team to share with.
                </p>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(Boolean(v))} />
            Make this the default view for this audience
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? "Saving…" : "Save view"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
