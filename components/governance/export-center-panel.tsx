"use client"

import { useEffect, useState } from "react"
import { Download, Plus } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { type ExportJob, listExportJobs, startExportJob, subscribeGovernance } from "@/lib/governance-store"

const MODULES = ["Employees (HR)", "Invoices (Finance)", "Leads (Sales)", "Customers (CRM)", "Full tenant export"]
const FORMATS = ["CSV", "Excel", "JSON", "PDF"]

export function ExportCenterPanel() {
  const [jobs, setJobs] = useState<ExportJob[]>([])
  const [module, setModule] = useState(MODULES[0])
  const [format, setFormat] = useState(FORMATS[0])

  useEffect(() => {
    const refresh = () => setJobs(listExportJobs())
    refresh()
    return subscribeGovernance(refresh)
  }, [])

  function start(recurring: boolean) {
    startExportJob({ module, format, recurring })
  }

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <CardTitle className="flex items-center gap-2">
            <Download className="size-4 text-muted-foreground" />
            New export
          </CardTitle>
          <CardDescription>Module, selected records, or a full tenant export. Large jobs run in the background.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-4">
          <div className="grid gap-3 sm:grid-cols-2 sm:max-w-lg">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="export-module">
                Module / scope
              </label>
              <Select value={module} onValueChange={setModule}>
                <SelectTrigger id="export-module">
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
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="export-format">
                Format
              </label>
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger id="export-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMATS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="gap-1.5" onClick={() => start(false)}>
              <Plus className="size-3.5" />
              Start export
            </Button>
            <Button size="sm" variant="outline" onClick={() => start(true)}>
              Schedule recurring export
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Export jobs</CardTitle>
          <CardDescription>Download links expire and are permission-checked at access time.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Module</TableHead>
                <TableHead>Format</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="text-right">File</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="text-sm">
                    {j.module}
                    {j.recurring ? (
                      <Badge variant="outline" className="ml-1.5 text-[9px]">
                        Recurring
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.format}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.requestedBy}</TableCell>
                  <TableCell className="w-32">
                    <Progress value={j.progress} className="h-1.5" />
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        j.status === "Completed" ? "secondary" : j.status === "Running" ? "outline" : "destructive"
                      }
                      className="text-[10px]"
                    >
                      {j.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.expires}</TableCell>
                  <TableCell className="text-right">
                    {j.file ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        onClick={() => downloadPlaceholder(j.file as string)}
                      >
                        <Download className="size-3.5" />
                        {j.file}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
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

function downloadPlaceholder(filename: string) {
  const blob = new Blob([`Simulated export file: ${filename}\nNo backend export job exists yet.`], {
    type: "text/plain",
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
