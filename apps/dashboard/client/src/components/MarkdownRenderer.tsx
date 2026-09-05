/**
 * MarkdownRenderer Component - Renders markdown content with syntax highlighting
 * Features: GFM support, code syntax highlighting, sanitization
 */
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn, copyToClipboard } from "@/lib/utils";
import { toast } from "sonner";
import type { Components } from "react-markdown";

// Custom code block component with better styling
const CodeBlock = ({
  className,
  children,
  ...props
}: React.ComponentProps<"pre">) => {
  const codeRef = React.useRef<HTMLElement>(null);

  return (
    <pre
      className={cn(
        "relative overflow-x-auto rounded-lg border border-border/30 bg-muted/50 p-4 my-3 text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    >
      <code ref={codeRef} className={cn("font-mono", className)}>
        {children}
      </code>
      <CopyButton text={String(children)} />
    </pre>
  );
};

// Copy button for code blocks
const CopyButton = ({ text }: { text: string }) => {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = () => {
    void copyToClipboard(text.trim()).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error("复制失败");
      }
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn(
        "absolute top-2 right-2 px-2 py-1 text-xs rounded-md transition-all",
        "bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground",
        copied && "text-green-600 bg-green-50",
      )}
    >
      {copied ? "已复制" : "复制"}
    </button>
  );
};

// Inline code component
const InlineCode = ({ className, ...props }: React.ComponentProps<"code">) => {
  return (
    <code
      className={cn(
        "px-1.5 py-0.5 rounded-md bg-muted/60 text-primary/80 font-mono text-[0.875em]",
        className,
      )}
      {...props}
    />
  );
};

export function buildSafeMarkdownHref(href?: string): string | undefined {
  if (!href) return href;
  const normalized = href.trim();

  try {
    const origin =
      typeof window === "undefined"
        ? "https://frontmind.invalid"
        : window.location.origin;
    const parsed = new URL(normalized, origin);
    if (parsed.pathname === "/api/frontmind/proxy-download") {
      const original = parsed.searchParams.get("url");
      if (!original) return undefined;
      const originalUrl = new URL(original);
      return originalUrl.protocol === "http:" ||
        originalUrl.protocol === "https:"
        ? original
        : undefined;
    }
    if (/^https?:\/\//i.test(normalized)) return normalized;
    if (/^(?:mailto:|tel:)/i.test(normalized)) return normalized;
    if (/^(?:[./]|#)/.test(normalized)) return normalized;
    return /^[a-z][a-z\d+.-]*:/i.test(normalized) ? undefined : normalized;
  } catch {
    return undefined;
  }
}

// Custom link component
const Link = ({
  className,
  href,
  children,
  ...props
}: React.ComponentProps<"a">) => {
  const safeHref = buildSafeMarkdownHref(href);
  const isExternal = /^https?:\/\//i.test(safeHref || "");
  return (
    <a
      href={safeHref}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
      className={cn(
        "text-primary underline-offset-2 hover:underline",
        className,
      )}
      {...props}
    >
      {children}
    </a>
  );
};

// Custom heading components
const Heading = ({
  level,
  className,
  children,
  ...props
}: { level: 1 | 2 | 3 | 4 | 5 | 6 } & React.ComponentProps<"h1">) => {
  const Tag = `h${level}` as React.ElementType;
  const sizeClasses: Record<number, string> = {
    1: "text-2xl font-bold",
    2: "text-xl font-semibold",
    3: "text-lg font-semibold",
    4: "text-base font-medium",
    5: "text-sm font-medium",
    6: "text-xs font-medium",
  };
  return (
    <Tag
      className={cn(sizeClasses[level], "mt-4 mb-2 text-foreground", className)}
      {...props}
    >
      {children}
    </Tag>
  );
};

// Table with horizontal scroll support
const Table = ({ className, ...props }: React.ComponentProps<"table">) => {
  return (
    <div className="overflow-x-auto my-3 rounded-lg border border-border/30">
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
};

// Task list checkbox (GFM)
const TaskListItem = ({
  className,
  children,
  ...props
}: React.ComponentProps<"li">) => {
  return (
    <li className={cn("list-none", className)} {...props}>
      {children}
    </li>
  );
};

// Custom components map
const components: Components = {
  // Headings
  h1: (props) => <Heading level={1} {...props} />,
  h2: (props) => <Heading level={2} {...props} />,
  h3: (props) => <Heading level={3} {...props} />,
  h4: (props) => <Heading level={4} {...props} />,
  h5: (props) => <Heading level={5} {...props} />,
  h6: (props) => <Heading level={6} {...props} />,

  // Code
  code: ({ className, children, ...props }) => {
    // Check if this is inside a pre (code block) or inline
    const isInline = !className;
    if (isInline) {
      return <InlineCode {...props}>{children}</InlineCode>;
    }
    return (
      <code className={cn("text-[13px]", className)} {...props}>
        {children}
      </code>
    );
  },
  pre: CodeBlock,

  // Links
  a: Link,

  // Table
  table: Table,
  thead: ({ className, ...props }) => (
    <thead className={cn("bg-muted/30", className)} {...props} />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "px-3 py-2 text-left font-medium text-foreground/80",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn("px-3 py-2 border-t border-border/30", className)}
      {...props}
    />
  ),

  // Lists - handle task lists specially
  ul: ({ className, children, ...props }) => {
    // Check if this contains task list items (checkboxes)
    const hasTaskList = String(children).includes('type="checkbox"');
    if (hasTaskList) {
      return (
        <ul className={cn("space-y-1", className)} {...props}>
          {children}
        </ul>
      );
    }
    return (
      <ul
        className={cn("list-disc list-inside space-y-1", className)}
        {...props}
      >
        {children}
      </ul>
    );
  },
  ol: ({ className, ...props }) => (
    <ol
      className={cn("list-decimal list-inside space-y-1", className)}
      {...props}
    />
  ),
  li: ({ className, children, ...props }) => {
    // Handle task list items with checkboxes
    const childStr = String(children);
    if (childStr.includes('type="checkbox"')) {
      return (
        <TaskListItem
          className={cn("flex items-start gap-2", className)}
          {...props}
        >
          {children}
        </TaskListItem>
      );
    }
    return (
      <li className={className} {...props}>
        {children}
      </li>
    );
  },

  // Blockquote
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "border-l-4 border-primary/30 pl-4 my-3 italic text-muted-foreground/80",
        className,
      )}
      {...props}
    />
  ),

  // Horizontal rule
  hr: (props) => <hr className="my-6 border-border/30" {...props} />,

  // Paragraph
  p: ({ className, ...props }) => (
    <p className={cn("leading-relaxed my-2", className)} {...props} />
  ),
};

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function MarkdownRendererInner({ content, className }: MarkdownRendererProps) {
  if (!content || typeof content !== "string") return null;

  return (
    <div className={cn("markdown-content", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Error-safe wrapper around MarkdownRendererInner.
 * If markdown parsing/rendering crashes (e.g., malformed content),
 * we fall back to plain text display instead of crashing the entire app.
 */
class MarkdownErrorBoundary extends React.Component<
  { children: React.ReactNode; fallbackContent?: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; fallbackContent?: string }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    console.error("[MarkdownRenderer] Render error caught:", error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="whitespace-pre-wrap break-words text-sm">
          {this.props.fallbackContent || ""}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps) {
  if (!content || typeof content !== "string") return null;

  return (
    <MarkdownErrorBoundary fallbackContent={content}>
      <MarkdownRendererInner content={content} className={className} />
    </MarkdownErrorBoundary>
  );
}
