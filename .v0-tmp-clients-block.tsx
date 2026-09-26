type ClientsPage = { clients: ClientRow[]; total: number; page: number; pageSize: number; pageCount: number }

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}

const ALL = "__all__"

export function ClientsClient({ canManage }: { canManage: boolean }) {
  const sv = useSavedViews({ tableKey: "clients", columns: CLIENT_COLUMNS, initial: { pageSize: 25 } })
  const search = sv.state.search
  const setSearch = sv.setSearch
  const debouncedSearch = useDebouncedValue(search.trim(), 300)
  const statusFilter = typeof sv.state.filters.status === "string" ? sv.state.filters.status : ""
  const loginFilter = typeof sv.state.filters.login === "string" ? sv.state.filters.login : ""
  const sortRule = sv.state.sort[0]

  // Any change to the query (search, filters, sort, page size) returns to page 1.
  const querySignature = JSON.stringify([debouncedSearch, statusFilter, loginFilter, sortRule, sv.state.pageSize])
  const [pageState, setPageState] = useState({ signature: querySignature, page: 1 })
  const page = pageState.signature === querySignature ? pageState.page : 1
  const setPage = (p: number) => setPageState({ signature: querySignature, page: p })

  const params = new URLSearchParams({ page: String(page), pageSize: String(sv.state.pageSize) })
  if (debouncedSearch) params.set("q", debouncedSearch)
  if (statusFilter) params.set("status", statusFilter)
  if (loginFilter) params.set("login", loginFilter)
  if (sortRule) {
    params.set("sort", sortRule.key)
    params.set("dir", sortRule.dir)
  }
  const { data, error, isLoading, isValidating, mutate } = useSWR<ClientsPage>(
    `/api/clients?${params.toString()}`,
    fetcher,
    { keepPreviousData: true },
  )

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ClientRow | null>(null)
  const [viewing, setViewing] = useState<ClientRow | null>(null)

  // open the create dialog when the command palette deep-links here.
  useNewRecordParam(() => {
    setEditing(null)
    setDialogOpen(true)
  }, canManage)
  const [merging, setMerging] = useState<ClientRow | null>(null)
  const [portalClient, setPortalClient] = useState<ClientRow | null>(null)

  // The merge target picker needs every client, so the full list is only loaded while merging.
  const { data: allData } = useSWR<{ clients: ClientRow[] }>(merging ? "/api/clients" : null, fetcher)
  const clients = allData?.clients ?? []
  const rows = data?.clients ?? []
  const total = data?.total ?? 0
  const pageCount = data?.pageCount ?? 1

  async function archiveClient(client: ClientRow) {
    if (!confirm(`Archive ${client.client_name}? Linked invoices stay intact and the client can be restored later.`)) return
    const res = await fetch(`/api/clients/${client.id}`, { method: "DELETE" })
    const body = await res.json().catch(() => ({}) as any)
    if (res.ok) {
      toast.success(body.deleted ? "Client deleted" : "Client archived")
      mutate()
    } else {
      toast.error(body.error || "Unable to archive client")
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Clients"
        description="Manage client accounts, company details and portal access."
        icon={BriefcaseBusiness}
        breadcrumbs={[{ label: "Home", href: "/dashboard" }, { label: "Clients" }]}
        actions={
          <>
            <ExcelExportButton
              rows={rows}
              filename="clients"
              label="Export page"
              columns={[
                { header: "Client Code", value: (r: ClientRow) => r.client_code },
                { header: "Client Name", value: (r: ClientRow) => `${r.salutation ? r.salutation + " " : ""}${r.client_name}` },
                { header: "Legal Name", value: (r: ClientRow) => r.legal_name },
                { header: "Client Type", value: (r: ClientRow) => r.client_type },
                { header: "Email", value: (r: ClientRow) => r.email },
                { header: "Mobile", value: (r: ClientRow) => r.mobile },
                { header: "Company", value: (r: ClientRow) => r.company_name },
                { header: "Company Code", value: (r: ClientRow) => r.company_code },
                { header: "Website", value: (r: ClientRow) => r.website },
                { header: "GSTIN", value: (r: ClientRow) => r.gst_number },
                { header: "PAN", value: (r: ClientRow) => r.pan },
                { header: "State Code", value: (r: ClientRow) => r.state_code },
                { header: "Finance Party", value: (r: ClientRow) => r.finance_party_id },
                { header: "Payment Terms (days)", value: (r: ClientRow) => r.payment_terms_days },
                { header: "Credit Limit", value: (r: ClientRow) => r.credit_limit },
                { header: "Account Manager", value: (r: ClientRow) => r.account_manager_name },
                { header: "Category", value: (r: ClientRow) => r.category },
                { header: "Sub Category", value: (r: ClientRow) => r.sub_category },
                { header: "City", value: (r: ClientRow) => r.city },
                { header: "State", value: (r: ClientRow) => r.state },
                { header: "Country", value: (r: ClientRow) => r.country },
                { header: "Currency", value: (r: ClientRow) => r.currency },
                { header: "Login Allowed", value: (r: ClientRow) => r.login_allowed },
                { header: "Status", value: (r: ClientRow) => r.status },
                { header: "Added", value: (r: ClientRow) => r.created_at },
              ]}
            />
            {canManage && <ImportButton moduleKey="clients" onImported={() => mutate()} />}
            {canManage && (
              <Button
                onClick={() => {
                  setEditing(null)
                  setDialogOpen(true)
                }}
              >
                <Plus className="size-4" aria-hidden="true" /> Add client
              </Button>
            )}
          </>
        }
      />

      <section aria-label="Filters" className="flex flex-wrap items-end gap-3">
        <div className="flex w-full flex-col gap-1.5 sm:w-72">
          <Label htmlFor="clients-search">Search</Label>
          <div className="relative">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
            <Input
              id="clients-search"
              type="search"
              className="pl-9"
              placeholder="Name, code, email, GSTIN..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="clients-status">Status</Label>
          <Select value={statusFilter || ALL} onValueChange={(v) => sv.setFilter("status", v === ALL ? null : (v as string))}>
            <SelectTrigger id="clients-status" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              <SelectItem value="Active">Active</SelectItem>
              <SelectItem value="Inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="clients-login">Portal login</Label>
          <Select value={loginFilter || ALL} onValueChange={(v) => sv.setFilter("login", v === ALL ? null : (v as string))}>
            <SelectTrigger id="clients-login" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Any</SelectItem>
              <SelectItem value="Yes">Allowed</SelectItem>
              <SelectItem value="No">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <SavedViewsBar hook={sv} />

      <DataTable<ClientRow>
        hook={sv}
        caption="Clients"
        rows={rows}
        getRowId={(c) => c.id}
        renderCell={(key, c) => renderClientCell(key, c, setViewing)}
        cellClassName={CELL_CLASS}
        groupValue={groupLabel}
        isLoading={isLoading && !data}
        isValidating={isValidating}
        error={error}
        onRetry={() => mutate()}
        total={total}
        page={page}
        pageCount={pageCount}
        onPageChange={setPage}
        emptyTitle="No clients found"
        emptyDescription={debouncedSearch || statusFilter || loginFilter ? "Try clearing search or filters." : undefined}
        rowActions={
          canManage
            ? (client) => (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button variant="ghost" size="icon-sm" aria-label={`Actions for ${client.client_name}`} />}
                  >
                    <MoreHorizontal className="size-4" aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setViewing(client)}>
                      <Eye className="size-4" /> View 360
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setEditing(client)
                        setDialogOpen(true)
                      }}
                    >
                      <Pencil className="size-4" /> Edit client
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPortalClient(client)}>
                      <ShieldCheck className="size-4" /> Manage portal
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setMerging(client)}>
                      <GitMerge className="size-4" /> Merge client
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" onClick={() => archiveClient(client)}>
                      Archive client
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            : undefined
        }
      />
