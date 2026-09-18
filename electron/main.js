// Muenot ERP desktop shell.
//
// Purpose: run the ERP web app inside Electron so that screen monitoring can
// capture the ENTIRE screen automatically — with no "Choose what to share"
// browser prompt and no user click.
//
// How the prompt is removed:
//   The renderer still calls navigator.mediaDevices.getDisplayMedia() exactly as
//   it does on the web (see components/hr/screen-monitor-provider.tsx). In a
//   normal browser that opens the native picker. In Electron we install a
//   setDisplayMediaRequestHandler on the session, resolve the primary monitor
//   ourselves via desktopCapturer, and hand it straight back — so the call
//   succeeds instantly with the full screen and the picker never appears.

const { app, BrowserWindow, session, desktopCapturer, screen, shell } = require("electron")
const path = require("node:path")

// The deployed ERP the desktop app should load. Override with ERP_URL if you
// point the app at staging or a local dev server.
const ERP_URL = process.env.ERP_URL || "https://erp.muenot.co.in"

// Only one instance so a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

/** @type {BrowserWindow | null} */
let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: "#0a0a0a",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Only our ERP origin loads in this window; external links open in the
      // system browser (see setWindowOpenHandler below).
      sandbox: false,
    },
  })

  mainWindow.once("ready-to-show", () => mainWindow?.show())

  // Open target=_blank / external links in the real browser, not a child window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url)
      const appOrigin = new URL(ERP_URL).origin
      if (target.origin !== appOrigin) {
        void shell.openExternal(url)
        return { action: "deny" }
      }
    } catch {
      return { action: "deny" }
    }
    return { action: "allow" }
  })

  void mainWindow.loadURL(ERP_URL)

  mainWindow.on("closed", () => {
    mainWindow = null
  })
}

// Auto-grant entire-screen capture with no picker. Called every time the page
// invokes getDisplayMedia(); we always return the primary monitor source.
function installDisplayMediaAutoGrant() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (!sources.length) {
            // Nothing to share — cancel the request gracefully.
            callback({})
            return
          }
          // Prefer the OS primary display in multi-monitor setups; fall back to
          // the first screen source.
          const primaryId = String(screen.getPrimaryDisplay().id)
          const primary = sources.find((s) => s.display_id === primaryId) || sources[0]
          callback({ video: primary })
        })
        .catch(() => callback({}))
    },
    // We supply the source ourselves, so disable Electron's own system picker.
    { useSystemPicker: false },
  )

  // Grant media-related permission requests coming from the ERP origin so the
  // renderer never has to prompt for screen/camera/mic access.
  const appOrigin = new URL(ERP_URL).origin
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done, details) => {
    const allowed = ["media", "display-capture", "clipboard-read", "clipboard-sanitized-write"]
    const requestingOrigin = details?.requestingUrl ? new URL(details.requestingUrl).origin : appOrigin
    done(requestingOrigin === appOrigin && allowed.includes(permission))
  })
}

app.whenReady().then(() => {
  installDisplayMediaAutoGrant()
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
