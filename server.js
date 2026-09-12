// Production startup file for Phusion Passenger (Hostinger shared hosting / LiteSpeed).
// Passenger launches this file (see .htaccess `PassengerStartupFile server.js`) and
// provides the port/socket to bind through process.env.PORT. Run `npm run build`
// before (re)starting the app so `.next` exists.
const { createServer } = require("http")
const { parse } = require("url")
const next = require("next")

const port = process.env.PORT || 3000
const app = next({ dev: false, dir: __dirname })
const handle = app.getRequestHandler()

app
  .prepare()
  .then(() => {
    createServer((req, res) => {
      handle(req, res, parse(req.url, true))
    }).listen(port, () => {
      console.log(`[server] Next.js ready, listening on ${port}`)
    })
  })
  .catch((err) => {
    console.error("[server] Failed to start Next.js", err)
    process.exit(1)
  })
