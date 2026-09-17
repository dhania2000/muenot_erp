import { notFound } from "next/navigation"
import { ensureLeadGenSchema, getPublicForm } from "@/lib/marketing/leadgen-db"
import { PublicLeadForm } from "@/components/marketing/public-lead-form"

export const dynamic = "force-dynamic"

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  await ensureLeadGenSchema()
  const form = await getPublicForm(token)
  if (!form) return { title: "Form not available" }
  return {
    title: form.name,
    description: form.description || "Get in touch with our team.",
  }
}

export default async function HostedLeadFormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  await ensureLeadGenSchema()
  const form = await getPublicForm(token)
  if (!form) notFound()

  const view = {
    form_code: form.form_code,
    public_token: form.public_token,
    name: form.name,
    description: form.description,
    submit_label: form.submit_label,
    success_message: form.success_message,
    redirect_url: form.redirect_url,
    theme_color: form.theme_color,
    fields: form.fields.map((f: any) => ({
      field_key: f.field_key,
      label: f.label,
      type: f.type,
      placeholder: f.placeholder,
      help_text: f.help_text,
      required: f.required,
      options: f.options,
    })),
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-muted/40 px-4 py-10">
      <PublicLeadForm form={view} />
    </main>
  )
}
