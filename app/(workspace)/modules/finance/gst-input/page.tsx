import { redirect } from "next/navigation"

// The standalone GST Input (ITC) module now lives inside the GST Compliance
// Center at Finance -> GST Filing. The old route is kept working (so existing
// links and bookmarks don't break) by redirecting to the dedicated tab.
export default function Page() {
  redirect("/modules/finance/gst-filing?tab=gst_input")
}
