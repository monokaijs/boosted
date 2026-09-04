import { memo } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { workspaceFileMarkdownComponents, workspaceMarkdownUrlTransform } from "@/components/assistant-ui/workspace-file-markdown";

export const MarkdownText = memo(function MarkdownText() {
  return <MarkdownTextPrimitive className="aui-markdown" components={workspaceFileMarkdownComponents} remarkPlugins={[remarkGfm]} urlTransform={workspaceMarkdownUrlTransform} smooth={false} defer />;
});
