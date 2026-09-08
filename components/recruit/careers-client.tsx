"use client"

import Link from "next/link"
import Image from "next/image"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Briefcase, Globe } from "lucide-react"

type PublicJob = { job_id: string }

export function CareersClient() {
  const { data } = useSWR<{ jobs: PublicJob[] }>("/api/recruit/public/jobs", fetcher)
  const openCount = data?.jobs?.length ?? 0

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 md:py-8">
      {/* Hero banner */}
      <div className="overflow-hidden rounded-t-xl border border-border">
        <div className="relative h-48 w-full sm:h-60 md:h-72">
          <Image src="/careers-hero.png" alt="Muenot workplace" fill priority className="object-cover" />
        </div>
      </div>

      {/* Company header card */}
      <div className="relative rounded-b-xl border border-t-0 border-border bg-card px-5 pb-6 pt-4 md:px-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-end gap-4">
            <span className="-mt-16 flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-border bg-card shadow-sm md:-mt-20 md:size-32">
              <Image src="/muenot-mark.png" alt="Muenot logo" width={128} height={128} className="size-full object-contain" />
            </span>
            <div className="pb-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">Muenot</h1>
              <a
                href="https://muenot.co.in"
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-blue-600"
              >
                <Globe className="size-3.5" /> https://muenot.co.in
              </a>
            </div>
          </div>
          <Link
            href="/job-opening"
            className="inline-flex items-center justify-center gap-2 self-start rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 sm:self-auto"
          >
            <Briefcase className="size-4" />
            Jobs{openCount > 0 ? ` (${openCount})` : ""}
          </Link>
        </div>
      </div>

      {/* Content card */}
      <div className="mt-6 rounded-xl border border-border bg-card px-5 py-6 md:px-8 md:py-8">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">Muenot</h2>
        <p className="mt-1 text-muted-foreground">Infinite Learning, Endless Possibilities</p>

        <section className="mt-6">
          <h3 className="text-base font-semibold text-foreground">About Us</h3>
          <p className="mt-2 leading-relaxed text-muted-foreground">
            Muenot is a learning-first organisation on a mission to make quality education accessible to everyone. We
            build content, platforms and programs that help learners grow and help businesses upskill their teams. Our
            focus on quality, mentorship and outcomes has made us a trusted name for infinite learning.
          </p>
        </section>

        <section className="mt-6">
          <h3 className="text-base font-semibold text-foreground">What We Do</h3>
          <div className="mt-2 flex flex-col gap-1.5 leading-relaxed text-muted-foreground">
            <p>Curriculum &amp; content: expertly crafted learning material across domains.</p>
            <p>Learning platform: an easy-to-use environment that simplifies studying and tracking progress.</p>
            <p>Mentorship: guidance from subject-matter experts to help learners stay ahead.</p>
            <p>Training &amp; support: onboarding and support to ensure successful adoption of our programs.</p>
          </div>
        </section>

        <section className="mt-6">
          <h3 className="text-base font-semibold text-foreground">Our Team</h3>
          <p className="mt-2 leading-relaxed text-muted-foreground">
            Muenot is powered by a talented and dedicated team of educators, engineers and creators. Our people bring a
            diverse set of skills and experiences to the table, allowing us to tackle complex challenges and deliver
            learning experiences that truly make a difference. We are committed to fostering a positive, collaborative
            environment where everyone has the opportunity to grow and succeed.
          </p>
        </section>

        <div className="mt-8 border-t border-border pt-6">
          <Link
            href="/job-opening"
            className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            <Briefcase className="size-4" />
            View open roles{openCount > 0 ? ` (${openCount})` : ""}
          </Link>
        </div>
      </div>
    </div>
  )
}
