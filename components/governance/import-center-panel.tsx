"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowRight, Upload } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { type ImportJob, completeImportJob, listImportJobs, subscribeGovernance } from "@/lib/governance-store"

const STEPS = ["Upload", "Map", "Validate", "Preview", "Import", "Result"]

const MODULES = [
  "Employees (HR)",
  "Chart of accounts (Finance)",
  "Journal entries (Finance)",
  "Leads (Sales)",
  "Companies (Sales)",
  "Contacts (Marketing)",
  "Products (Catalog)",
  "Knowledge base",
]

export function ImportCenterPanel() {
  const [jobs, setJobs] = useState<ImportJob[]>([])
  const [module, setModule] = useState(MODULES[0])
  const [file, setFile] = useState<File | null>(null)
  const [step, setStep] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const refresh = () => setJobs(listImportJobs())
    refresh()
    return subscribeGovernance(refresh)
  }, [])

  function handleFile(f: File | null) {
    setFile(f)
    setStep(f ? 1 : 0)
  }

  function advance() {
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1)
      return
    }
    finishImport()
  }

  function finishImport() {
    if (!file) return
    const rowCount = 40 + Math.floor(Math.random() * 120)
    completeImportJob({ module, file: file.name, rowCount })
    setFile(null)
    setStep(0)
    if (inputRef.current) inputRef.current.value = ""
  }

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4 text-muted-foreground" />
            New import
          </CardTitle>
          <CardDescription>CSV, Excel, or JSON. Large imports run as a background job.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5 pt-4">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-1.5">
                <span
                  className={
                    i <= step
                      ? "flex size-6 items-center justify-center rounded-full bg-primary text-[11px] font-medium text-primary-foreground"
                      : "flex size-6 items-center justify-center rounded-full border border-border text-[11px] text-muted-foreground"
                  }
                >
                  {i + 1}
                </span>
                <span className={i <= step ? "font-medium" : "text-muted-foreground"}>{s}</span>
                {i < STEPS.length - 1 ? <ArrowRight className="size-3 text-muted-foreground" /> : null}
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3 sm:max-w-sm">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="import-module">
              Target module
            </label>
            <Select value={module} onValueChange={setModule}>
              <SelectTrigger id="import-module">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODULES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-border p-10 text-center">
            <Upload className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {file ? file.name : "Drag a file here, or click to browse"}
            </p>
            <p className="text-xs text-muted-foreground">Supports .csv, .xlsx, .json — up to 25 MB</p>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx,.json"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            />
            <Button size="sm" variant="outline" className="mt-1" onClick={() => inputRef.current?.click()}>
              Choose file
            </Button>
          </div>

          <div className="flex justify-end">
            <Button disabled={!file} onClick={advance}>
              {step < STEPS.length - 1 ? `Continue to ${STEPS[step + 1].toLowerCase()}` : "Finish import"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Import history</CardTitle>
          <CardDescription>Row-level error reports are attached to each completed job.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>File</TableHead>
                <TableHead>Success</TableHead>
                <TableHead>Failed</TableHead>
                <TableHead>Skipped</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="text-sm">{h.module}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.file}</TableCell>
                  <TableCell className="text-xs">{h.success}</TableCell>
                  <TableCell className="text-xs">{h.failed}</TableCell>
                  <TableCell className="text-xs">{h.skipped}</TableCell>
                  <TableCell>
                    <Badge variant={h.status === "Completed" ? "secondary" : "destructive"} className="text-[10px]">
                      {h.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right text-xs text-muted-foreground">
                    {h.when}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  )
}
