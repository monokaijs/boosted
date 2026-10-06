import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import jsonWorker from "monaco-editor/language/json/json.worker.js?worker";
import cssWorker from "monaco-editor/language/css/css.worker.js?worker";
import htmlWorker from "monaco-editor/language/html/html.worker.js?worker";
import typescriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import { themePalettes } from "@/lib/palette";

self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new typescriptWorker();
    return new editorWorker();
  },
};

for (const [theme, palette] of Object.entries(themePalettes)) {
  monaco.editor.defineTheme(`boosted-${theme}`, {
    base: theme === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": palette.surface,
      "editor.foreground": palette.foreground,
      "editorGutter.background": palette.surface,
      "editorLineNumber.foreground": palette.muted,
      "editorLineNumber.activeForeground": palette.foreground,
      "editor.lineHighlightBackground": palette.canvas,
      "editor.selectionBackground": `${palette.primary}33`,
      "editor.inactiveSelectionBackground": `${palette.primary}22`,
      "editorIndentGuide.background1": palette.canvas,
      "editorWidget.background": palette.canvas,
      "editorWidget.border": palette.canvas,
      "scrollbarSlider.background": `${palette.muted}33`,
      "scrollbarSlider.hoverBackground": `${palette.muted}55`,
      "scrollbarSlider.activeBackground": `${palette.muted}77`,
    },
  });
}

loader.config({ monaco });

export default Editor;
