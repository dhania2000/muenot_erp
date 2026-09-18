import type { BillingModuleConfig } from "@/components/billing/billing-module-view"

export const BILLING_CONFIGS: Record<string, BillingModuleConfig> = {
  overview: {
    title: "Subscription & Billing",
    description:
      "Manage the full billing lifecycle — plans, subscriptions, entitlements, invoicing, payments, reconciliation and reporting — from a single admin console.",
    layout: "reports",
    stats: [
      { label: "Active subscriptions", value: "1", hint: "0 trialing" },
      { label: "Monthly recurring", value: "$0", hint: "$0 ARR" },
      { label: "Open invoices", value: "0", hint: "$0 outstanding" },
      { label: "Failed payments", value: "0", hint: "last 30 days" },
    ],
    reports: [
      { title: "Subscription Management", description: "View and manage every active, trialing and cancelled subscription.", meta: "Operate" },
      { title: "Plan Management", description: "Define pricing plans, tiers and billing intervals.", meta: "Configure" },
      { title: "Invoices & Credit Notes", description: "Issue, track and reconcile customer invoices and credit notes.", meta: "Operate" },
      { title: "Payment Gateways", description: "Connect and monitor payment processors.", meta: "Configure" },
      { title: "Payment Reconciliation", description: "Match settlements against invoices and gateway payouts.", meta: "Finance" },
      { title: "Billing Reports", description: "Revenue, churn, MRR and collection analytics.", meta: "Insights" },
    ],
  },

  subscriptions: {
    title: "Subscription Management",
    description: "Track every customer subscription, its plan, billing cycle and lifecycle status.",
    primaryAction: "New subscription",
    layout: "table",
    stats: [
      { label: "Active", value: "1" },
      { label: "Trialing", value: "0" },
      { label: "Past due", value: "0" },
      { label: "Cancelled", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "plan", label: "Plan" },
      { key: "cycle", label: "Cycle" },
      { key: "amount", label: "Amount" },
      { key: "renews", label: "Renews" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { customer: "Muenot Technologies", plan: "Enterprise", cycle: "Monthly", amount: "$0.00", renews: "18 Oct 2026", status: "Active" },
    ],
  },

  plans: {
    title: "Plan Management",
    description: "Define the pricing plans, tiers and billing intervals customers can subscribe to.",
    primaryAction: "New plan",
    layout: "table",
    stats: [
      { label: "Plans", value: "3" },
      { label: "Published", value: "3" },
      { label: "Draft", value: "0" },
      { label: "Intervals", value: "2" },
    ],
    statusKey: "status",
    columns: [
      { key: "name", label: "Plan" },
      { key: "price", label: "Price" },
      { key: "interval", label: "Interval" },
      { key: "seats", label: "Seats" },
      { key: "subscribers", label: "Subscribers" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { name: "Starter", price: "$29", interval: "Monthly", seats: "Up to 10", subscribers: "0", status: "Active" },
      { name: "Growth", price: "$99", interval: "Monthly", seats: "Up to 50", subscribers: "0", status: "Active" },
      { name: "Enterprise", price: "Custom", interval: "Annual", seats: "Unlimited", subscribers: "1", status: "Active" },
    ],
  },

  entitlements: {
    title: "Feature Entitlements",
    description: "Map plan-level features and quota limits that gate what each subscription can access.",
    primaryAction: "New entitlement",
    layout: "table",
    stats: [
      { label: "Features", value: "12" },
      { label: "Metered", value: "4" },
      { label: "Boolean", value: "8" },
      { label: "Overrides", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "feature", label: "Feature" },
      { key: "type", label: "Type" },
      { key: "plan", label: "Plan" },
      { key: "limit", label: "Limit" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { feature: "Active users", type: "Metered", plan: "Enterprise", limit: "Unlimited", status: "Active" },
      { feature: "Storage", type: "Metered", plan: "Growth", limit: "500 GB", status: "Active" },
      { feature: "API access", type: "Boolean", plan: "Enterprise", limit: "Enabled", status: "Active" },
      { feature: "Advanced analytics", type: "Boolean", plan: "Starter", limit: "Disabled", status: "Disabled" },
    ],
  },

  "usage-metering": {
    title: "Usage Metering",
    description: "Record and aggregate metered usage events that feed usage-based billing and quotas.",
    primaryAction: "Export usage",
    layout: "table",
    stats: [
      { label: "Meters", value: "4" },
      { label: "Events today", value: "0" },
      { label: "Billable units", value: "0" },
      { label: "Over quota", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "meter", label: "Meter" },
      { key: "customer", label: "Customer" },
      { key: "period", label: "Period" },
      { key: "usage", label: "Usage" },
      { key: "included", label: "Included" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { meter: "Active users", customer: "Muenot Technologies", period: "Sept 2026", usage: "4", included: "Unlimited", status: "Active" },
      { meter: "Storage (GB)", customer: "Muenot Technologies", period: "Sept 2026", usage: "0", included: "Unlimited", status: "Active" },
    ],
  },

  billing: {
    title: "Billing",
    description: "The billing run overview — upcoming charges, billing schedule and the current billing period.",
    primaryAction: "Run billing",
    layout: "table",
    stats: [
      { label: "Due this cycle", value: "$0.00" },
      { label: "Scheduled", value: "1" },
      { label: "Processing", value: "0" },
      { label: "Failed", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "plan", label: "Plan" },
      { key: "period", label: "Billing period" },
      { key: "amount", label: "Amount" },
      { key: "chargeOn", label: "Charge on" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { customer: "Muenot Technologies", plan: "Enterprise", period: "Sept 2026", amount: "$0.00", chargeOn: "18 Oct 2026", status: "Scheduled" },
    ],
  },

  "payment-gateways": {
    title: "Payment Gateways",
    description: "Connect and monitor the payment processors used to collect subscription and invoice payments.",
    primaryAction: "Connect gateway",
    layout: "table",
    stats: [
      { label: "Connected", value: "0" },
      { label: "Live", value: "0" },
      { label: "Test mode", value: "0" },
      { label: "Default", value: "—" },
    ],
    statusKey: "status",
    columns: [
      { key: "gateway", label: "Gateway" },
      { key: "mode", label: "Mode" },
      { key: "currencies", label: "Currencies" },
      { key: "methods", label: "Methods" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { gateway: "Stripe", mode: "—", currencies: "—", methods: "Card, UPI", status: "Disabled" },
      { gateway: "Razorpay", mode: "—", currencies: "INR", methods: "Card, UPI, Netbanking", status: "Disabled" },
    ],
  },

  "payment-webhooks": {
    title: "Payment Webhooks",
    description: "Inspect inbound webhook events from payment gateways and their delivery status.",
    primaryAction: "Add endpoint",
    layout: "table",
    stats: [
      { label: "Endpoints", value: "0" },
      { label: "Delivered", value: "0" },
      { label: "Pending", value: "0" },
      { label: "Failed", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "event", label: "Event" },
      { key: "gateway", label: "Gateway" },
      { key: "endpoint", label: "Endpoint" },
      { key: "received", label: "Received" },
      { key: "status", label: "Status" },
    ],
    rows: [],
  },

  invoices: {
    title: "Invoices & Credit Notes",
    description: "Issue, send and track customer invoices and credit notes across the billing lifecycle.",
    primaryAction: "New invoice",
    layout: "table",
    stats: [
      { label: "Open", value: "0", hint: "$0 outstanding" },
      { label: "Paid", value: "0" },
      { label: "Overdue", value: "0" },
      { label: "Credit notes", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "number", label: "Number" },
      { key: "customer", label: "Customer" },
      { key: "type", label: "Type" },
      { key: "amount", label: "Amount" },
      { key: "due", label: "Due" },
      { key: "status", label: "Status" },
    ],
    rows: [],
  },

  renewals: {
    title: "Renewals",
    description: "Track upcoming subscription renewals, auto-renew status and renewal reminders.",
    primaryAction: "Renewal settings",
    layout: "table",
    stats: [
      { label: "Due in 30 days", value: "1" },
      { label: "Auto-renew", value: "1" },
      { label: "Manual", value: "0" },
      { label: "At risk", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "plan", label: "Plan" },
      { key: "renewsOn", label: "Renews on" },
      { key: "amount", label: "Amount" },
      { key: "mode", label: "Mode" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { customer: "Muenot Technologies", plan: "Enterprise", renewsOn: "18 Oct 2026", amount: "$0.00", mode: "Auto-renew", status: "Active" },
    ],
  },

  "customer-portal": {
    title: "Customer Billing Portal",
    description: "Configure the self-service portal where customers manage their plan, payment methods and invoices.",
    layout: "settings",
    toggleGroups: [
      {
        title: "Portal capabilities",
        items: [
          { label: "Update payment method", description: "Let customers add or replace cards and payment methods.", enabled: true },
          { label: "Download invoices", description: "Allow customers to view and download past invoices.", enabled: true },
          { label: "Change plan", description: "Enable self-service upgrades and downgrades.", enabled: false },
          { label: "Cancel subscription", description: "Allow customers to cancel from the portal.", enabled: false },
        ],
      },
      {
        title: "Branding & access",
        items: [
          { label: "Custom logo", description: "Show your company logo on the portal.", enabled: true },
          { label: "Require login link", description: "Send a secure magic link instead of a shared URL.", enabled: true },
        ],
      },
    ],
  },

  coupons: {
    title: "Coupons & Discounts",
    description: "Create promotional coupons and discounts that apply to plans and subscriptions.",
    primaryAction: "New coupon",
    layout: "table",
    stats: [
      { label: "Active", value: "0" },
      { label: "Scheduled", value: "0" },
      { label: "Redeemed", value: "0" },
      { label: "Expired", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "code", label: "Code" },
      { key: "type", label: "Type" },
      { key: "value", label: "Value" },
      { key: "redemptions", label: "Redemptions" },
      { key: "expires", label: "Expires" },
      { key: "status", label: "Status" },
    ],
    rows: [],
  },

  credits: {
    title: "Credits & Adjustments",
    description: "Apply account credits and manual adjustments that offset future invoices.",
    primaryAction: "Add credit",
    layout: "table",
    stats: [
      { label: "Credit balance", value: "$0.00" },
      { label: "Issued", value: "0" },
      { label: "Applied", value: "0" },
      { label: "Adjustments", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "reason", label: "Reason" },
      { key: "amount", label: "Amount" },
      { key: "issued", label: "Issued" },
      { key: "status", label: "Status" },
    ],
    rows: [],
  },

  refunds: {
    title: "Refunds",
    description: "Review and process refunds against captured payments and issued invoices.",
    primaryAction: "New refund",
    layout: "table",
    stats: [
      { label: "This month", value: "$0.00" },
      { label: "Pending", value: "0" },
      { label: "Succeeded", value: "0" },
      { label: "Failed", value: "0" },
    ],
    statusKey: "status",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "invoice", label: "Invoice" },
      { key: "amount", label: "Amount" },
      { key: "reason", label: "Reason" },
      { key: "date", label: "Date" },
      { key: "status", label: "Status" },
    ],
    rows: [],
  },

  reconciliation: {
    title: "Payment Reconciliation",
    description: "Match gateway settlements and bank payouts against invoices to keep the ledger accurate.",
    primaryAction: "Start reconciliation",
    layout: "table",
    stats: [
      { label: "Matched", value: "0" },
      { label: "Unmatched", value: "0" },
      { label: "Payouts", value: "0" },
      { label: "Variance", value: "$0.00" },
    ],
    statusKey: "status",
    columns: [
      { key: "reference", label: "Reference" },
      { key: "gateway", label: "Gateway" },
      { key: "payout", label: "Payout" },
      { key: "invoice", label: "Invoice" },
      { key: "amount", label: "Amount" },
      { key: "status", label: "Status" },
    ],
    rows: [],
  },

  settings: {
    title: "Billing Settings",
    description: "Configure global billing behaviour — currency, tax, invoicing defaults and dunning.",
    layout: "settings",
    toggleGroups: [
      {
        title: "Invoicing",
        items: [
          { label: "Auto-send invoices", description: "Email invoices to customers automatically when generated.", enabled: true },
          { label: "Attach PDF", description: "Include a PDF copy with every invoice email.", enabled: true },
          { label: "Sequential numbering", description: "Use a strict sequential invoice number series.", enabled: true },
        ],
      },
      {
        title: "Tax",
        items: [
          { label: "Collect tax", description: "Apply tax rates to invoices based on customer location.", enabled: true },
          { label: "Prices include tax", description: "Treat catalog prices as tax-inclusive.", enabled: false },
        ],
      },
      {
        title: "Dunning & retries",
        items: [
          { label: "Retry failed payments", description: "Automatically retry declined charges on a schedule.", enabled: true },
          { label: "Dunning emails", description: "Send reminder emails for past-due invoices.", enabled: true },
        ],
      },
    ],
  },

  reports: {
    title: "Billing Reports",
    description: "Revenue, growth and collection analytics across your subscription base.",
    layout: "reports",
    stats: [
      { label: "MRR", value: "$0" },
      { label: "ARR", value: "$0" },
      { label: "Churn", value: "0%" },
      { label: "Collections", value: "$0" },
    ],
    reports: [
      { title: "MRR & ARR", description: "Recurring revenue trends by plan and interval.", meta: "Revenue" },
      { title: "Churn & retention", description: "Cancellations, downgrades and net revenue retention.", meta: "Growth" },
      { title: "Collections", description: "Invoiced vs collected, outstanding and overdue aging.", meta: "Finance" },
      { title: "Payment success", description: "Authorization and settlement success rates by gateway.", meta: "Payments" },
      { title: "Coupon impact", description: "Discount redemption and revenue impact.", meta: "Marketing" },
      { title: "Tax summary", description: "Tax collected by jurisdiction for the period.", meta: "Compliance" },
    ],
  },
}
