"use client"

import useSWR from "swr"
import { Users, MessageSquare, Inbox, Clock, TrendingUp, Megaphone } from "lucide-react"

import { StatCard } from "@/components/marketing/marketing-shared"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { TabState } from "./shared"
import type { WhatsAppAnalytics, WhatsAppCaps } from "./types"

/** Analytics dashboard: totals, per-department, per-agent and campaign rollups. */
export function AnalyticsTab({ caps }: { caps: WhatsAppCaps | null }) {
  const allowed = caps?.canViewAnalytics ?? false
  const { data, isLoading } = useSWR<{ analytics: WhatsAppAnalytics }>(
    allowed ? "/api/marketing/whatsapp/analytics" : null,
    fetcher,
  )

  if (!allowed) return <TabState>You don&apos;t have permission to view analytics.</TabState>
  if (isLoading) return <TabState loading>Loading analytics…</TabState>
  if (!data?.analytics) return <TabState>No analytics available yet.</TabState>

  const a = data.analytics
  const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—")

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Contacts" value={a.totals.contacts} hint={`${a.totals.optedInContacts} opted in`} icon={Users} />
        <StatCard label="Open conversations" value={a.totals.openConversations} hint={`${a.totals.unassigned} unassigned`} icon={Inbox} />
        <StatCard label="Messages (7d)" value={a.totals.inbound7d + a.totals.outbound7d} hint={`${a.totals.inbound7d} in / ${a.totals.outbound7d} out`} icon={MessageSquare} />
        <StatCard
          label="Avg first response"
          value={a.avgFirstResponseMinutes != null ? `${a.avgFirstResponseMinutes}m` : "—"}
          hint={`${a.totals.activeAutomations} active automations`}
          icon={Clock}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="size-4" /> Departments
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Department</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Agents</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.departments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">No data</TableCell>
                  </TableRow>
                ) : (
                  a.departments.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>{d.name}</TableCell>
                      <TableCell className="text-right">{d.open}</TableCell>
                      <TableCell className="text-right">{d.agents}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="size-4" /> Agents (last 7 days)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Closed</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.agents.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">No data</TableCell>
                  </TableRow>
                ) : (
                  a.agents.map((ag) => (
                    <TableRow key={ag.userId}>
                      <TableCell>{ag.name}</TableCell>
                      <TableCell className="text-right">{ag.open}</TableCell>
                      <TableCell className="text-right">{ag.closed7d}</TableCell>
                      <TableCell className="text-right">{ag.sent7d}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="size-4" /> Campaign performance
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Recipients</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Read</TableHead>
                <TableHead className="text-right">Replied</TableHead>
                <TableHead className="text-right">Read rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.campaigns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">No campaigns yet</TableCell>
                </TableRow>
              ) : (
                a.campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="capitalize text-muted-foreground">{c.status}</TableCell>
                    <TableCell className="text-right">{c.total}</TableCell>
                    <TableCell className="text-right">{c.sent}</TableCell>
                    <TableCell className="text-right">{c.delivered}</TableCell>
                    <TableCell className="text-right">{c.read}</TableCell>
                    <TableCell className="text-right">{c.replied}</TableCell>
                    <TableCell className="text-right">{rate(c.read, c.delivered)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
