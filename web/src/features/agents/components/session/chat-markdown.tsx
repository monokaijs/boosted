import { createElement, memo, useMemo, type ComponentPropsWithoutRef } from "react"
import { type Components, defaultUrlTransform } from "react-markdown"
import { TaskMarkdown, type SaveCheckbox } from "@/components/assistant-ui/task-markdown"
import { cn } from "@/lib/utils"

type MarkdownContentProps = {
  animateChanges?: boolean
  compact?: boolean
  saveCheckbox?: SaveCheckbox
  content: string
  openFileLink?: (href: string) => boolean
  scopeKey?: string | null
}

const urlTransform = (url: string) => localFileLike(url) ? url : defaultUrlTransform(url)

export const MarkdownContent = memo(function MarkdownContent({
  animateChanges,
  compact,
  content,
  openFileLink,
  saveCheckbox,
}: MarkdownContentProps) {
  const components = useMemo(() => markdownComponents(openFileLink), [openFileLink])
  return (
    <div className={cn("chat-markdown min-w-0 max-w-full text-[13px]", compact && "leading-5", animateChanges && "chat-markdown-streaming")}>
      <TaskMarkdown content={content} saveCheckbox={animateChanges ? undefined : saveCheckbox} components={components} urlTransform={urlTransform} />
    </div>
  )
})

function markdownComponents(openFileLink?: (href: string) => boolean): Components {
  return {
    a: ({ children, href, ...props }) => (
      <a
        {...props}
        className="text-info underline decoration-info/40 underline-offset-2 hover:text-info"
        href={href}
        rel={externalHref(href) ? "noreferrer" : undefined}
        target={externalHref(href) ? "_blank" : undefined}
        onClick={(event) => {
          if (href && openFileLink?.(href)) event.preventDefault()
        }}
      >
        {children}
      </a>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote {...props} className="my-3 min-w-0 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
    ),
    code: ({ children, className, ...props }) => {
      const fenced = Boolean(className?.startsWith("language-"))
      return (
        <code
          {...props}
          className={fenced
            ? cn("font-mono text-[12px] text-foreground", className)
            : "rounded bg-background px-1 py-0.5 font-mono text-[12px] text-foreground"}
        >
          {children}
        </code>
      )
    },
    h1: heading("h1", "text-[18px]"),
    h2: heading("h2", "text-[16px]"),
    h3: heading("h3", "text-[15px]"),
    h4: heading("h4", "text-[14px]"),
    h5: heading("h5", "text-[13px]"),
    h6: heading("h6", "text-[13px]"),
    hr: (props) => <hr {...props} className="my-3 border-border" />,
    img: ({ alt, src, ...props }) => (
      <img {...props} alt={alt ?? "Markdown image"} className="my-3 max-h-[32rem] max-w-full rounded-md border border-border object-contain" src={src} />
    ),
    li: ({ children, ...props }) => <li {...props} className="min-w-0 pl-0.5">{children}</li>,
    ol: ({ children, ...props }) => <ol {...props} className="my-2 grid list-decimal gap-1 pl-5">{children}</ol>,
    p: ({ children, ...props }) => <p {...props} className="my-2 min-w-0 first:mt-0 last:mb-0 leading-6">{children}</p>,
    pre: ({ children, ...props }) => (
      <pre {...props} className="my-3 min-w-0 max-w-full overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[12px] leading-5 text-foreground ide-scrollbar">
        {children}
      </pre>
    ),
    table: ({ children, ...props }) => (
      <div className="my-3 min-w-0 max-w-full overflow-auto ide-scrollbar">
        <table {...props} className="w-full border-collapse text-left text-[12px]">{children}</table>
      </div>
    ),
    td: ({ children, ...props }) => <td {...props} className="border border-border px-2 py-1 align-top">{children}</td>,
    th: ({ children, ...props }) => <th {...props} className="border border-border bg-accent px-2 py-1 font-semibold text-foreground">{children}</th>,
    ul: ({ children, ...props }) => <ul {...props} className="my-2 grid list-disc gap-1 pl-5">{children}</ul>,
  }
}

function heading(tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", className: string) {
  return ({ children, ...props }: ComponentPropsWithoutRef<"h1">) => createElement(
    tag,
    { ...props, className: cn("mb-2 mt-4 font-semibold text-foreground first:mt-0", className) },
    children,
  )
}

function externalHref(href: string | undefined): boolean {
  return Boolean(href && /^(https?:|mailto:)/iu.test(href))
}

function localFileLike(url: string): boolean {
  return /^(?:file:|\/|\.\.?\/|[A-Za-z]:[\\/])/u.test(url)
}
