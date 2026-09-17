"use client"

import { useEffect, useImperativeHandle, useRef, forwardRef, useCallback } from "react"
import { cn } from "@/lib/utils"
import {
  Bold,
  Italic,
  Underline,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Table as TableIcon,
  Eraser,
  Pilcrow,
} from "lucide-react"

export type RichEditorHandle = {
  insertToken: (token: string) => void
  focus: () => void
}

type Props = {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  className?: string
}

const TABLE_HTML =
  '<table style="width:100%;border-collapse:collapse;margin:8px 0"><tbody>' +
  '<tr><td style="border:1px solid #cbd5e1;padding:6px">&nbsp;</td><td style="border:1px solid #cbd5e1;padding:6px">&nbsp;</td></tr>' +
  '<tr><td style="border:1px solid #cbd5e1;padding:6px">&nbsp;</td><td style="border:1px solid #cbd5e1;padding:6px">&nbsp;</td></tr>' +
  "</tbody></table><p><br/></p>"

function ToolbarButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      // preventDefault on mousedown keeps the editor selection intact
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&>svg]:size-4"
    >
      {children}
    </button>
  )
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
}

export const ContractRichEditor = forwardRef<RichEditorHandle, Props>(function ContractRichEditor(
  { value, onChange, placeholder, className },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null)
  const savedRange = useRef<Range | null>(null)
  const lastEmitted = useRef<string>("")

  // Seed the editor once (and when an external value replaces the content,
  // e.g. loading a different template) without clobbering the caret mid-typing.
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (value !== lastEmitted.current) {
      el.innerHTML = value || ""
      lastEmitted.current = value || ""
    }
  }, [value])

  const saveSelection = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const range = sel.getRangeAt(0)
    if (editorRef.current?.contains(range.commonAncestorContainer)) {
      savedRange.current = range.cloneRange()
    }
  }, [])

  const emit = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const html = el.innerHTML
    lastEmitted.current = html
    onChange(html)
  }, [onChange])

  const exec = useCallback(
    (command: string, arg?: string) => {
      const el = editorRef.current
      if (!el) return
      el.focus()
      if (savedRange.current) {
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(savedRange.current)
      }
      document.execCommand(command, false, arg)
      saveSelection()
      emit()
    },
    [emit, saveSelection],
  )

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    insertToken: (token: string) => {
      const el = editorRef.current
      if (!el) return
      el.focus()
      const sel = window.getSelection()
      if (savedRange.current && sel) {
        sel.removeAllRanges()
        sel.addRange(savedRange.current)
      }
      document.execCommand("insertText", false, `{{${token}}}`)
      saveSelection()
      emit()
    },
  }))

  return (
    <div className={cn("overflow-hidden rounded-lg border border-input bg-background", className)}>
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 p-1.5">
        <ToolbarButton title="Heading 1" onClick={() => exec("formatBlock", "H1")}>
          <Heading1 />
        </ToolbarButton>
        <ToolbarButton title="Heading 2" onClick={() => exec("formatBlock", "H2")}>
          <Heading2 />
        </ToolbarButton>
        <ToolbarButton title="Paragraph" onClick={() => exec("formatBlock", "P")}>
          <Pilcrow />
        </ToolbarButton>
        <Divider />
        <ToolbarButton title="Bold" onClick={() => exec("bold")}>
          <Bold />
        </ToolbarButton>
        <ToolbarButton title="Italic" onClick={() => exec("italic")}>
          <Italic />
        </ToolbarButton>
        <ToolbarButton title="Underline" onClick={() => exec("underline")}>
          <Underline />
        </ToolbarButton>
        <Divider />
        <ToolbarButton title="Bulleted list" onClick={() => exec("insertUnorderedList")}>
          <List />
        </ToolbarButton>
        <ToolbarButton title="Numbered list" onClick={() => exec("insertOrderedList")}>
          <ListOrdered />
        </ToolbarButton>
        <Divider />
        <ToolbarButton title="Align left" onClick={() => exec("justifyLeft")}>
          <AlignLeft />
        </ToolbarButton>
        <ToolbarButton title="Align center" onClick={() => exec("justifyCenter")}>
          <AlignCenter />
        </ToolbarButton>
        <ToolbarButton title="Align right" onClick={() => exec("justifyRight")}>
          <AlignRight />
        </ToolbarButton>
        <Divider />
        <ToolbarButton title="Insert table" onClick={() => exec("insertHTML", TABLE_HTML)}>
          <TableIcon />
        </ToolbarButton>
        <ToolbarButton title="Clear formatting" onClick={() => exec("removeFormat")}>
          <Eraser />
        </ToolbarButton>
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Contract body editor"
        data-placeholder={placeholder}
        onInput={emit}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        onBlur={saveSelection}
        className={cn(
          "contract-editor min-h-[320px] max-h-[52vh] overflow-y-auto px-4 py-3 text-sm leading-relaxed outline-none",
          "prose-editor [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-semibold",
          "[&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold",
          "[&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-6",
          "[&_table]:my-2 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:p-1.5",
          "empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
        )}
      />
    </div>
  )
})
