import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getProduct } from "@/lib/products-db"
import { getProductSession, canEditProduct } from "@/lib/products-api-auth"
import { logProductAudit } from "@/lib/products-audit"
import { uploadFile } from "@/lib/storage"

export const runtime = "nodejs"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const documents = await query<any[]>(
    `SELECT d.*, u.name AS uploaded_by_name FROM product_documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.product_pk = ? ORDER BY d.id DESC`,
    [Number(id)],
  )
  return NextResponse.json({ documents })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const pk = Number(id)
  const product = await getProduct(pk)
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 })
  if (!(await canEditProduct(ctx.session, product))) {
    return NextResponse.json({ error: "You do not have permission to edit this product." }, { status: 403 })
  }

  const form = await req.formData()
  const file = form.get("file")
  const docType = String(form.get("doc_type") || "Product Document")
  if (!(file instanceof File)) return NextResponse.json({ error: "File is required" }, { status: 400 })

  const up = await uploadFile(`products/${pk}/${crypto.randomUUID()}-${file.name}`, file)
  if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 })
  const url = up.result.url

  const result = (await query(
    `INSERT INTO product_documents (product_pk, doc_type, file_name, url, uploaded_by) VALUES (?,?,?,?,?)`,
    [pk, docType, file.name, url, ctx.session.userId],
  )) as any

  // The first uploaded image becomes the product thumbnail if none is set.
  if (docType === "Image" && !product.image_url) {
    await query(`UPDATE products SET image_url = ? WHERE id = ?`, [url, pk])
  }

  await logProductAudit({
    productPk: pk,
    productId: product.product_id,
    action: "document_added",
    newValue: file.name,
    userId: ctx.session.userId,
    userName: ctx.session.name,
  })

  return NextResponse.json({ ok: true, id: result.insertId, url: blob.url, file_name: file.name, doc_type: docType })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getProductSession()
  if (!ctx) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const pk = Number(id)
  const product = await getProduct(pk)
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 })
  if (!(await canEditProduct(ctx.session, product))) {
    return NextResponse.json({ error: "You do not have permission to edit this product." }, { status: 403 })
  }
  const docId = Number(req.nextUrl.searchParams.get("doc_id"))
  if (!docId) return NextResponse.json({ error: "doc_id is required" }, { status: 400 })
  await query(`DELETE FROM product_documents WHERE id = ? AND product_pk = ?`, [docId, pk])
  return NextResponse.json({ ok: true })
}
