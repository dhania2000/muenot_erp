// Exposes a tiny, safe flag so the ERP web app can tell it is running inside
// the Muenot desktop shell (e.g. to skip the "click Share" instruction, since
// screen capture is automatic here). No Node APIs are leaked to the page.

const { contextBridge } = require("electron")

contextBridge.exposeInMainWorld("muenotDesktop", {
  isDesktop: true,
  // Screen capture requires no user interaction inside the desktop shell.
  autoScreenShare: true,
})
