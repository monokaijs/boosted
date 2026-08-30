import { memo } from "react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";

export const MarkdownText = memo(function MarkdownText() {
  return <MarkdownTextPrimitive className="aui-markdown" remarkPlugins={[remarkGfm]} smooth={false} defer />;
});
