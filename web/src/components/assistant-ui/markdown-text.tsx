import { memo } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { taskMarkdownComponents, remarkTaskPositions } from "./task-markdown";
import remarkGfm from "remark-gfm";
import { workspaceFileMarkdownComponents, workspaceMarkdownUrlTransform } from "@/components/assistant-ui/workspace-file-markdown";

export const MarkdownText = memo(function MarkdownText() {
  return <MarkdownTextPrimitive className="aui-markdown" components={{ ...workspaceFileMarkdownComponents, ...taskMarkdownComponents }} remarkPlugins={[remarkGfm, remarkTaskPositions]} urlTransform={workspaceMarkdownUrlTransform} smooth={false} defer />;
});
