"use client"

// Segment-level error boundary for every workspace module. Without it, an
// unhandled runtime exception in a sub-module (e.g. Financial Reports) escapes
// all the way to Next.js's built-in error UI ("This page couldn't load"),
// blanking the entire app with no in-app recovery. This boundary keeps the
// failure contained: it renders inside the workspace shell and offers a retry
// (reset()) so a transient render error no longer takes down the whole page.

import { useEffect } from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[v0] Workspace module render error:", error)
  }, [error])

  return (
    <main className="flex min-h-[60vh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-row items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <AlertTriangle className="size-5" />
          </div>
          <CardTitle className="text-base">This page ran into a problem</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Something went wrong while loading this module. You can try again, and if the problem
            keeps happening, narrow any active filters or report period and reload.
          </p>
          {error?.digest && (
            <p className="text-xs text-muted-foreground">
              Reference: <span className="font-mono">{error.digest}</span>
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => reset()}>
              <RefreshCw data-icon="inline-start" />
              Try again
            </Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
