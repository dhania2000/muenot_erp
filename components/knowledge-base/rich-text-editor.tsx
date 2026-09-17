"use client"

import { useEffect, useRef } from "react"
import {
  Bold, Italic, Underline, Strikethrough, List, ListOrdered, Quote, Code,
  Link2, Heading1, Heading2, Heading3, Table as TableIcon, Undo, Redo, RemoveFormatting,
} from "lucide-react"
import { cn } from "@/lib/utils"

type Props = {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  className?: string
}

// A lightweight contentEditable rich-text editor. It emits HTML which the
// server sanitizes (sanitizeContent) before storage, so the toolbar can stay
// simple while remaining safe.
export function RichTextEditor({ value, onChange, placeholder, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // Seed the DOM only when the incoming value diverges from what's rendered,
  // so typing (which updates state) never resets the caret.
  useEffect(() => {
    const el = ref.current
    if (el && el.innerHTML !== value) el.innerHTML = value || ""
  }, [value])

  const exec = (command: string, arg?: string) => {
    ref.current?.focus()
    document.execCommand(command, false, arg)
    if (ref.current) onChange(ref.current.innerHTML)
  }

  const format = (tag: string) => exec("formatBlock", tag)

  const insertLink = () => {
    const url = window.prompt("Enter URL")
    if (url) exec("createLink", url)
  }

  const insertTable = () => {
    const rows = Math.min(20, Math.max(1, Number(window.prompt("Rows", "2") || 0)))
    const cols = Math.min(10, Math.max(1, Number(window.prompt("Columns", "2") || 0)))
    if (!rows || !cols) return
    let html = '<table><tbody>'
    for (let r = 0; r < rows; r++) {
      html += "<tr>"
      for (let c = 0; c < cols; c++) html += r === 0 ? "<th>Heading</th>" : "<td>Cell</td>"
      html += "</tr>"
    }
    html += "</tbody></table><p><br/></p>"
    exec("insertHTML", html)
  }

  const Btn = ({ onClick, title, children }: { onClick: () => void; title: string; children: React.ReactNode }) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&_svg]:size-4"
    >
      {children}
    </button>
  )

  const Divider = () => <span className="mx-0.5 h-5 w-px shrink-0 bg-border" />

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-background", className)}>
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/30 p-1">
        <Btn title="Heading 1" onClick={() => format("h1")}><Heading1 /></Btn>
        <Btn title="Heading 2" onClick={() => format("h2")}><Heading2 /></Btn>
        <Btn title="Heading 3" onClick={() => format("h3")}><Heading3 /></Btn>
        <Btn title="Paragraph" onClick={() => format("p")}><RemoveFormatting /></Btn>
        <Divider />
        <Btn title="Bold" onClick={() => exec("bold")}><Bold /></Btn>
        <Btn title="Italic" onClick={() => exec("italic")}><Italic /></Btn>
        <Btn title="Underline" onClick={() => exec("underline")}><Underline /></Btn>
        <Btn title="Strikethrough" onClick={() => exec("strikeThrough")}><Strikethrough /></Btn>
        <Divider />
        <Btn title="Bulleted list" onClick={() => exec("insertUnorderedList")}><List /></Btn>
        <Btn title="Numbered list" onClick={() => exec("insertOrderedList")}><ListOrdered /></Btn>
        <Btn title="Quote" onClick={() => format("blockquote")}><Quote /></Btn>
        <Btn title="Code block" onClick={() => format("pre")}><Code /></Btn>
        <Divider />
        <Btn title="Insert link" onClick={insertLink}><Link2 /></Btn>
        <Btn title="Insert table" onClick={insertTable}><TableIcon /></Btn>
        <Divider />
        <Btn title="Undo" onClick={() => exec("undo")}><Undo /></Btn>
        <Btn title="Redo" onClick={() => exec("redo")}><Redo /></Btn>
      </div>
      <div
        ref={ref}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Article content"
        data-placeholder={placeholder || "Write the content…"}
        onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
        className={cn(
          "kb-prose min-h-[220px] max-h-[420px] overflow-y-auto px-3.5 py-3 text-sm leading-relaxed outline-none",
          "empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
        )}
      />
    </div>
  )
}
