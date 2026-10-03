export const palette = {
  canvas: "#1b1b1c",
  surface: "#111111",
  foreground: "#e3e3e3",
  muted: "#a0a0a0",
  primary: "#b8b8b8",
  success: "#69c795",
  warning: "#d7a653",
  danger: "#e16d75",
} as const;

export const graphLaneColors = [palette.primary, palette.success, palette.warning, palette.danger] as const;
