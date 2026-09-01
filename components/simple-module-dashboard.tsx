"use client"

import { useState } from "react"

type ModuleKind = "clients" | "tickets" | "products"

const config: Record<ModuleKind, { title: string; eyebrow: string; description: string; action: string; fields: string[]; columns: string[]; cards: string[] }> = {
  clients: { title: "Clients", eyebrow: "Relationship workspace", description: "Manage client profiles, contacts, and account health.", action: "Add client", fields: ["client name", "company", "email", "phone", "status"], columns: ["Client", "Company", "Email", "Status"], cards: ["Total clients", "Active accounts", "Needs attention"] },
  tickets: { title: "Tickets", eyebrow: "Support workspace", description: "Track requests, assign owners, and keep service work moving.", action: "Create ticket", fields: ["ticket title", "client", "priority", "assignee", "description"], columns: ["Ticket", "Client", "Priority", "Status"], cards: ["Open tickets", "In progress", "Resolved"] },
  products: { title: "Products", eyebrow: "Catalog workspace", description: "Maintain products, pricing, inventory, and availability.", action: "Add product", fields: ["product name", "SKU", "category", "price", "stock"], columns: ["Product", "SKU", "Price", "Stock"], cards: ["Total products", "In stock", "Low stock"] },
}

export function SimpleModuleDashboard({ module }: { module: ModuleKind }) {
  const item = config[module]
  const [saved, setSaved] = useState(false)
  return <main className="space-y-6 p-6">
    <div><p className="text-sm text-muted-foreground">{item.eyebrow}</p><h1 className="text-3xl font-semibold tracking-tight">{item.title}</h1><p className="mt-1 text-muted-foreground">{item.description}</p></div>
    <div className="grid gap-4 md:grid-cols-3">{item.cards.map((card) => <section key={card} className="rounded-xl border bg-card p-5"><p className="text-sm text-muted-foreground">{card}</p><p className="mt-3 text-3xl font-semibold">0</p></section>)}</div>
    <section className="rounded-xl border bg-card p-5"><h2 className="mb-4 text-lg font-semibold">{item.action}</h2><div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">{item.fields.map((field) => field === "description" ? <textarea key={field} className="min-h-24 rounded-md border bg-background p-3" placeholder={field} /> : <input key={field} className="rounded-md border bg-background p-3" placeholder={field} />)}</div><button className="mt-4 rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={() => setSaved(true)}>{saved ? "Saved" : "Save record"}</button></section>
    <section className="overflow-hidden rounded-xl border bg-card"><div className="border-b p-5"><h2 className="font-semibold">{item.title} records</h2></div><div className="grid min-w-[640px] grid-cols-4 gap-4 p-5 text-sm text-muted-foreground">{item.columns.map((column) => <div key={column} className="font-medium">{column}</div>)}</div><div className="border-t p-8 text-center text-sm text-muted-foreground">No records yet. Add your first record above.</div></section>
  </main>
}
