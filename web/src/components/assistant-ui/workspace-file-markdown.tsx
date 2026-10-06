import { createContext, useContext, useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { defaultUrlTransform, type Components } from "react-markdown";
import { AttachmentPreview } from "@/components/attachment-preview";
import type { MessageAttachment } from "@/lib/types";
import type { WorkspaceFileScope } from "@/lib/api";
import { useBoostedApiClient } from "@/lib/api-context";

const WorkspaceReadOnlyContext = createContext(false);
const WorkspaceFileContext = createContext<WorkspaceFileScope | undefined>(undefined);

export function WorkspaceFileProvider({ scope, children, readOnly = false }: { scope: WorkspaceFileScope; children: ReactNode; readOnly?: boolean }) {
  const value = useMemo<WorkspaceFileScope>(() => ({ kind: scope.kind, id: scope.id }), [scope.id, scope.kind]);
  return <WorkspaceReadOnlyContext.Provider value={readOnly}><WorkspaceFileContext.Provider value={value}>{children}</WorkspaceFileContext.Provider></WorkspaceReadOnlyContext.Provider>;
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function localWorkspacePath(value?: string) {
  if (!value) return undefined;
  const decoded = decodePath(value);
  if (decoded.startsWith("#")) return undefined;
  if (/^[a-z]:[\\/]/i.test(decoded)) return decoded;
  if (decoded.startsWith("file://")) {
    try {
      const url = new URL(decoded);
      const host = url.hostname && url.hostname !== "localhost" ? `//${url.hostname}` : "";
      let path = `${host}${decodePath(url.pathname)}`;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      return path;
    } catch {
      return decoded.slice("file://".length);
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith("//")) return undefined;
  return decoded;
}

export function workspaceMarkdownUrlTransform(value: string) {
  return localWorkspacePath(value) ?? defaultUrlTransform(value);
}

export function workspaceFileName(path: string) {
  const withoutFragment = path.replace(/#L?\d+(?:-L\d+)?$/, "");
  const withoutLine = withoutFragment.replace(/:\d+$/, "");
  return withoutLine.split(/[\\/]/).filter(Boolean).pop() ?? "artifact";
}

type MarkdownAnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown };

function WorkspaceFileLink({ node: _node, href, children, onClick: _onClick, ...props }: MarkdownAnchorProps) {
  const api = useBoostedApiClient();
  const scope = useContext(WorkspaceFileContext);
  const readOnly = useContext(WorkspaceReadOnlyContext);
  const path = localWorkspacePath(href);
  if (!scope || !path) {
    const external = Boolean(href && /^[a-z][a-z\d+.-]*:/i.test(href));
    return <a {...props} href={href} target={external ? "_blank" : props.target} rel={external ? "noreferrer" : props.rel}>{children}</a>;
  }
  return <AttachmentPreview name={workspaceFileName(path)} sourceKey={`${api.profileId}:${scope.kind}:${scope.id}:${path}`} load={() => api.workspaceFile(scope, path)} saveCheckbox={scope.kind === "task" && !readOnly ? (edit) => api.toggleMarkdownCheckbox(`/tasks/${encodeURIComponent(scope.id)}`, "file", path, edit) : undefined} label={children} className="border-0 bg-transparent text-primary underline underline-offset-4" />;
}

export function WorkspaceAttachment({ attachment, compact }: { attachment: MessageAttachment; compact?: boolean }) {
  const api = useBoostedApiClient();
  const scope = useContext(WorkspaceFileContext);
  const readOnly = useContext(WorkspaceReadOnlyContext);
  const { name, mimeType, path, url, uploadId } = attachment;
  return <AttachmentPreview name={name} mimeType={mimeType} src={url} compact={compact}
    saveCheckbox={!uploadId && scope?.kind === "task" && path && !readOnly ? (edit) => api.toggleMarkdownCheckbox(`/tasks/${encodeURIComponent(scope.id)}`, "file", path, edit) : undefined}
    sourceKey={`${api.profileId}:${uploadId ?? (path ? `${scope?.kind}:${scope?.id}:${path}` : url)}`}
    load={uploadId ? () => api.codexAttachment(uploadId) : scope && path ? () => api.workspaceFile(scope, path) : undefined} />;
}

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

function WorkspaceFileImage({ node: _node, src, alt, ...props }: MarkdownImageProps) {
  const api = useBoostedApiClient();
  const scope = useContext(WorkspaceFileContext);
  const path = localWorkspacePath(src);
  return <AttachmentPreview name={path ? workspaceFileName(path) : alt || "Image attachment"} mimeType="image/*" src={path ? undefined : src} sourceKey={path ? `${api.profileId}:${scope?.kind}:${scope?.id}:${path}` : src} load={scope && path ? () => api.workspaceFile(scope, path) : undefined} className={props.className} />;
}

export const workspaceFileMarkdownComponents: Components = {
  a: WorkspaceFileLink,
  img: WorkspaceFileImage,
};
