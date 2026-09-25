// Minimal Stripe API stand-in for the E2E checkout smoke test.
// Point the app at it with STRIPE_API_BASE=http://127.0.0.1:12111/v1.
// Honours Idempotency-Key the way Stripe does: same key → same PaymentIntent.
import { createServer } from "node:http"

const port = Number(process.env.MOCK_STRIPE_PORT || 12111)
const byKey = new Map()
let seq = 0

createServer((req, res) => {
  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/v1/payment_intents") {
      const key = req.headers["idempotency-key"]
      const params = new URLSearchParams(body)
      const intent =
        (key && byKey.get(key)) ?? {
          id: `pi_mock_${++seq}`,
          object: "payment_intent",
          amount: Number(params.get("amount")),
          currency: params.get("currency"),
          status: "requires_payment_method",
          client_secret: `pi_mock_${seq}_secret_test`,
        }
      if (key) byKey.set(key, intent)
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(intent))
    }
    if (req.url === "/health") {
      res.writeHead(200)
      return res.end("ok")
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: { message: "not mocked" } }))
  })
}).listen(port, "127.0.0.1", () => console.log(`mock stripe on :${port}`))
