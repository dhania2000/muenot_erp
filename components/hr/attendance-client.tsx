"use client"
import { useEffect, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

const fields: [string, string][] = [
  ["attendance_id", "Attendance ID"],
  ["employee_id", "Employee ID"],
  ["employee_name", "Employee Name"],
  ["work_date", "Work Date"],
  ["clock_in", "Clock In"],
  ["clock_out", "Clock Out"],
  ["break_minutes", "Break Minutes"],
  ["status", "Status"],
  ["late_minutes", "Late Minutes"],
  ["early_leaving_minutes", "Early Leaving Minutes"],
  ["overtime_hours", "Overtime Hours"],
  ["location", "Location"],
  ["latitude", "Latitude"],
  ["longitude", "Longitude"],
  ["source", "Source"],
  ["remarks", "Remarks"],
]

// Location fields are captured automatically from the device and cannot be typed by hand.
const LOCATION_KEYS = new Set(["location", "latitude", "longitude"])
type LocationStatus = "idle" | "fetching" | "ready" | "error"

const emptyForm = () => ({
  work_date: new Date().toISOString().slice(0, 10),
  status: "Present",
  source: "Manual",
}) as Record<string, string>

export function AttendanceClient() {
  const { data, mutate } = useSWR<{ attendance: any[] }>("/api/hr/attendance", fetcher)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Record<string, string>>(emptyForm)
  const [locStatus, setLocStatus] = useState<LocationStatus>("idle")
  const [locError, setLocError] = useState("")
  const rows = data?.attendance ?? []

  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }))

  async function captureLocation() {
    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      setLocStatus("error")
      setLocError("This device does not support location. Attendance cannot be added here.")
      return
    }
    setLocStatus("fetching")
    setLocError("")
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude
        const lng = position.coords.longitude
        let label = `${lat.toFixed(6)}, ${lng.toFixed(6)}`
        try {
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`,
            { headers: { Accept: "application/json" } },
          )
          if (res.ok) {
            const geo = await res.json()
            if (geo?.display_name) label = geo.display_name
          }
        } catch {
          // Reverse geocoding is best-effort; coordinates remain the fallback label.
        }
        setForm((current) => ({
          ...current,
          latitude: String(lat),
          longitude: String(lng),
          location: label,
        }))
        setLocStatus("ready")
      },
      (err) => {
        setLocStatus("error")
        setLocError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission denied. Please allow location access to add attendance."
            : "Could not fetch location. Please try again.",
        )
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  }

  // Automatically request the device location the moment the dialog opens.
  useEffect(() => {
    if (open) captureLocation()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const hasLocation = locStatus === "ready" && !!form.latitude && !!form.longitude

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!hasLocation) {
      setLocError("Location is required. Please capture your location before saving.")
      return
    }
    await fetch("/api/hr/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    setOpen(false)
    setForm(emptyForm())
    setLocStatus("idle")
    setLocError("")
    mutate()
  }

  return (
    <main className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Attendance</h1>
          <p className="text-sm text-muted-foreground">Daily attendance, work hours and regularisation tracking.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger>Add attendance</DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Add attendance record</DialogTitle>
            </DialogHeader>
            <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2 rounded-md border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">Location capture</span>
                  <Button type="button" variant="outline" size="sm" onClick={captureLocation} disabled={locStatus === "fetching"}>
                    {locStatus === "fetching" ? "Fetching…" : hasLocation ? "Refresh location" : "Fetch location"}
                  </Button>
                </div>
                {locStatus === "fetching" && <p className="mt-2 text-muted-foreground">Fetching your current location…</p>}
                {hasLocation && <p className="mt-2 text-muted-foreground">Captured: {form.location}</p>}
                {locStatus === "error" && <p className="mt-2 text-destructive">{locError}</p>}
              </div>
              {fields.map(([key, label]) => {
                const isLocation = LOCATION_KEYS.has(key)
                return (
                  <div key={key} className={key === "remarks" ? "sm:col-span-2" : ""}>
                    <Label htmlFor={key}>
                      {label}
                      {isLocation && " *"}
                    </Label>
                    {key === "remarks" ? (
                      <Textarea id={key} value={form[key] || ""} onChange={(e) => update(key, e.target.value)} />
                    ) : (
                      <Input
                        id={key}
                        type={
                          key.includes("date")
                            ? "date"
                            : key.includes("clock")
                              ? "datetime-local"
                              : key.includes("minutes") || key.includes("hours") || key === "latitude" || key === "longitude"
                                ? "number"
                                : "text"
                        }
                        value={form[key] || ""}
                        onChange={(e) => update(key, e.target.value)}
                        required={["attendance_id", "employee_id", "employee_name", "work_date"].includes(key) || isLocation}
                        readOnly={isLocation}
                        placeholder={isLocation ? "Auto-filled from device location" : undefined}
                      />
                    )}
                  </div>
                )
              })}
              <Button type="submit" className="sm:col-span-2" disabled={!hasLocation}>
                Save attendance
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </header>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-left">
              <th className="p-3">Attendance ID</th>
              <th className="p-3">Employee</th>
              <th className="p-3">Work Date</th>
              <th className="p-3">In / Out</th>
              <th className="p-3">Hours</th>
              <th className="p-3">Status</th>
              <th className="p-3">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row: any) => (
              <tr key={row.id} className="border-b">
                <td className="p-3">{row.attendance_id}</td>
                <td className="p-3">
                  {row.employee_name}
                  <div className="text-xs text-muted-foreground">#{row.employee_id}</div>
                </td>
                <td className="p-3">{row.work_date}</td>
                <td className="p-3">
                  {row.clock_in || "—"} / {row.clock_out || "—"}
                </td>
                <td className="p-3">{row.working_hours ?? "—"}</td>
                <td className="p-3">{row.status}</td>
                <td className="p-3">{row.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  )
}
