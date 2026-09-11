"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Pencil, ShieldCheck, Trash2, ExternalLink, MoreHorizontal, Archive } from "lucide-react"

export default function ReproDropdownPage() {
  const e = { id: 3, employee_name: "Hriddhi", archived_at: null as string | null }
  return (
    <div className="p-20">
      <div className="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Open ${e.employee_name} profile`}
          render={<Link href={`/modules/hr/employees/${e.id}`} />}
        >
          <ExternalLink className="size-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon" aria-label={`More actions for ${e.employee_name}`}>
                <MoreHorizontal className="size-4" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{e.employee_name}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => console.log("[v0] edit")}>
              <Pencil className="size-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link href={`/modules/hr/employees/${e.id}?tab=permissions`} />}>
              <ShieldCheck className="size-4" /> Permissions
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => console.log("[v0] archive")}>
              <Archive className="size-4" /> Archive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => console.log("[v0] delete")} className="text-destructive focus:text-destructive">
              <Trash2 className="size-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
