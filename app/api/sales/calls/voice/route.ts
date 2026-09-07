import { NextResponse } from "next/server"
import twilio from "twilio"
import { getCallerId } from "@/lib/twilio"

export const dynamic = "force-dynamic"

// TwiML webhook invoked by Twilio when the browser Device places a call.
// It bridges the browser leg to the lead's phone number using our caller ID.
// Point your TwiML App's Voice Request URL at this endpoint.
async function handle(request: Request) {
  const contentType = request.headers.get("content-type") || ""
  let to = ""
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await request.formData()
    to = String(form.get("To") || "")
  } else {
    const url = new URL(request.url)
    to = url.searchParams.get("To") || ""
  }

  const response = new twilio.twiml.VoiceResponse()
  const callerId = getCallerId()

  if (!to || !callerId) {
    response.say("We are unable to place your call at this time. Please try again later.")
  } else {
    const dial = response.dial({ callerId, answerOnBridge: true })
    dial.number(to)
  }

  return new NextResponse(response.toString(), {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  })
}

export async function POST(request: Request) {
  return handle(request)
}

export async function GET(request: Request) {
  return handle(request)
}
