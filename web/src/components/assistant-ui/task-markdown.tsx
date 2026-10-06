import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export type CheckboxEdit = { expected: string; offset: number; checked: boolean };
export type SaveCheckbox = (edit: CheckboxEdit) => Promise<unknown>;

// Positions come from the GFM parser, never from matching rendered labels or line numbers.
type SourceNode = { type: string; checked?: boolean | null; position?: { start: { offset?: number }; end: { offset?: number } }; children?: SourceNode[]; data?: { hProperties?: Record<string, unknown> } };
export function remarkTaskPositions() {
  return (tree: SourceNode, file: { value: unknown }) => {
    const source = String(file.value);
    // Micromark consumes an initial BOM before counting source offsets.
    const bomOffset = source.startsWith("\uFEFF") ? 1 : 0;
    const sourceOffset = (offset: number | undefined) => offset === undefined ? undefined : offset + bomOffset;
    function visit(node: SourceNode) {
      if (node.type === "listItem" && typeof node.checked === "boolean") {
        const paragraph = node.children?.[0];
        const start = sourceOffset(node.position?.start.offset);
        const labelStart = sourceOffset(paragraph?.position?.start.offset);
        // GFM advances paragraph positions past the checkbox. Resolve the marker
        // only within this parser-confirmed list item's bullet prefix.
        const prefix = start === undefined || labelStart === undefined ? undefined : /\[[ xX]\](?:[ \t\r\n]|>)*$/.exec(source.slice(start, labelStart));
        if (start !== undefined && prefix) {
          const offset = start + prefix.index + 1;
          node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-task-offset": offset,
            "data-task-label": source.slice(labelStart ?? offset + 2, sourceOffset(paragraph?.position?.end.offset)).trim() || "Task" } };
        }
      }
      node.children?.forEach(visit);
    }
    visit(tree);
  };
}
export function toggleMarkdown({ expected, offset, checked }: CheckboxEdit) {
  if (expected[offset - 1] !== "[" || expected[offset + 1] !== "]" || !/^[ xX]$/.test(expected[offset] ?? "")) throw new Error("Task marker is no longer available.");
  return expected.slice(0, offset) + (checked ? "x" : " ") + expected.slice(offset + 1);
}
const Task = createContext<{ offset?: number; label?: string }>({});
const Source = createContext<{ content: string; save?: SaveCheckbox; pending: boolean; toggle(edit: CheckboxEdit): void } | null>(null);
export const taskMarkdownComponents: Components = {
  li: ({ node, children, ...props }) => {
    const offset = node?.properties?.["data-task-offset"];
    const label = node?.properties?.["data-task-label"];
    return <Task.Provider value={{ offset: typeof offset === "number" ? offset : undefined, label: typeof label === "string" ? label : undefined }}><li {...props}>{children}</li></Task.Provider>;
  },
  input: ({ node: _node, ...props }) => {
    const task = useContext(Task);
    const source = useContext(Source);
    const disabled = !source?.save || source.pending || task.offset === undefined;
    return <input {...props} type="checkbox" checked={Boolean(props.checked)} disabled={disabled}
      aria-label={task.label ?? "Task checkbox"} title={disabled ? source?.pending ? "Saving checkbox…" : "Read-only Markdown" : "Update task checkbox"}
      className="mr-1 accent-primary focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed"
      onChange={(event) => { if (!disabled && source && task.offset !== undefined) source.toggle({ expected: source.content, offset: task.offset, checked: event.target.checked }); }} />;
  },
};
// A new persistence callback or pending state must not reparse unchanged text.
const MarkdownBody = memo(function MarkdownBody({ content, components, urlTransform }: {
  content: string; components: Components; urlTransform?: (url: string) => string;
}) {
  return <ReactMarkdown components={components} remarkPlugins={[remarkGfm, remarkTaskPositions]} urlTransform={urlTransform}>{content}</ReactMarkdown>;
});

export const TaskMarkdown = memo(function TaskMarkdown({ content, saveCheckbox, components, className, urlTransform }: {
  content: string; saveCheckbox?: SaveCheckbox; components?: Components; className?: string; urlTransform?: (url: string) => string;
}) {
  const [saved, setSaved] = useState<{ original: string; content: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const busy = useRef(false);
  const current = useRef(content);
  current.current = content;
  const displayed = saved?.original === content ? saved.content : content;
  useEffect(() => { setSaved((previous) => previous?.original === content ? previous : undefined); }, [content]);
  const renderers = useMemo<Components>(() => {
    const Li = typeof components?.li === "function" ? components.li : undefined;
    return { ...components, ...taskMarkdownComponents, ...(Li ? {
      li: ({ node, children, ...props }) => {
        const offset = node?.properties?.["data-task-offset"];
        const label = node?.properties?.["data-task-label"];
        return <Task.Provider value={{ offset: typeof offset === "number" ? offset : undefined, label: typeof label === "string" ? label : undefined }}><Li {...props} node={node}>{children}</Li></Task.Provider>;
      },
    } : {}) };
  }, [components]);
  const value = { content: displayed, save: saveCheckbox, pending, toggle: (edit: CheckboxEdit) => {
    if (busy.current || !saveCheckbox) return;
    busy.current = true; setPending(true); setError(undefined);
    const original = content;
    void saveCheckbox(edit).then(() => {
      if (current.current === original) setSaved({ original, content: toggleMarkdown(edit) });
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to save checkbox."))
      .finally(() => { busy.current = false; setPending(false); });
  } };
  return <Source.Provider value={value}><div className={className} aria-busy={pending || undefined}>
    <MarkdownBody content={displayed} components={renderers} urlTransform={urlTransform} />
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
  </div></Source.Provider>;
});
