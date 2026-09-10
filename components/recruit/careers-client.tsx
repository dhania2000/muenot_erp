"use client"

import Link from "next/link"
import Image from "next/image"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Briefcase, Globe } from "lucide-react"
import { CAREERS_DEFAULTS, whatWeDoItems, type CareersContent } from "@/lib/careers-content"

type PublicJob = { job_id: string }

export function CareersClient({ content = CAREERS_DEFAULTS }: { content?: CareersContent }) {
  const { data } = useSWR<{ jobs: PublicJob[] }>("/api/recruit/public/jobs", fetcher)
  const openCount = data?.jobs?.length ?? 0
  const doItems = whatWeDoItems(content)

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      {/* Hero banner */}
      <div className="overflow-hidden rounded-t-xl border border-border">
        <div className="relative h-48 w-full sm:h-60 md:h-72">
          <Image
            src={content.heroImage || "/careers-hero.png"}
            alt={`${content.companyName} workplace`}
            fill
            priority
            className="object-cover"
          />
        </div>
      </div>

      {/* Company header card */}
      <div className="relative rounded-b-xl border border-t-0 border-border bg-card px-5 pb-6 pt-4 md:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-end gap-4">
            <span className="-mt-16 flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-card shadow-sm md:-mt-20 md:size-32">
              <Image
                src={content.logoMark || "/muenot-mark.png"}
                alt={`${content.companyName} logo`}
                width={128}
                height={128}
                className="size-full object-contain"
              />
            </span>
            <div className="pb-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">{content.companyName}</h1>
              {content.websiteUrl && (
                <a
                  href={content.websiteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-[var(--careers-accent)]"
                >
                  <Globe className="size-3.5" /> {content.websiteUrl}
                </a>
              )}
            </div>
          </div>
          <Link
            href="/job-opening"
            style={{ backgroundColor: "var(--careers-accent)" }}
            className="inline-flex items-center justify-center gap-2 self-start rounded-md px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90 sm:self-auto"
          >
            <Briefcase className="size-4" />
            Jobs{openCount > 0 ? ` (${openCount})` : ""}
          </Link>
        </div>
      </div>

      {/* Content card */}
      <div className="mt-6 rounded-xl border border-border bg-card px-5 py-6 md:px-8 md:py-8">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">{content.companyName}</h2>
        {content.tagline && <p className="mt-1 text-muted-foreground">{content.tagline}</p>}

        {content.aboutText && (
          <section className="mt-6">
            <h3 className="text-base font-semibold text-foreground">{content.aboutHeading}</h3>
            <p className="mt-2 leading-relaxed text-muted-foreground text-pretty">{content.aboutText}</p>
          </section>
        )}

        {doItems.length > 0 && (
          <section className="mt-6">
            <h3 className="text-base font-semibold text-foreground">{content.whatWeDoHeading}</h3>
            <div className="mt-2 flex flex-col gap-1.5 leading-relaxed text-muted-foreground">
              {doItems.map((item, i) => (
                <p key={i}>{item}</p>
              ))}
            </div>
          </section>
        )}

        {content.teamText && (
          <section className="mt-6">
            <h3 className="text-base font-semibold text-foreground">{content.teamHeading}</h3>
            <p className="mt-2 leading-relaxed text-muted-foreground text-pretty">{content.teamText}</p>
          </section>
        )}

        <div className="mt-8 border-t border-border pt-6">
          <Link
            href="/job-opening"
            style={{ backgroundColor: "var(--careers-accent)" }}
            className="inline-flex items-center justify-center gap-2 rounded-md px-5 py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
          >
            <Briefcase className="size-4" />
            View open roles{openCount > 0 ? ` (${openCount})` : ""}
          </Link>
        </div>
      </div>
    </div>
  )
}
