export default function AutomationLayout({ children }: { children: React.ReactNode }) {
  // Give the automation pages consistent breathing room on both sides so their
  // content is not flush against the sidebar (the inner components only center
  // with max-width and add no horizontal padding of their own).
  return <div className="px-4 py-6 md:px-8">{children}</div>
}
