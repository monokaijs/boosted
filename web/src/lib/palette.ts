export const palette = {
  canvas: "#0e0e0e",
  surface: "#121212",
  foreground: "#e3e3e3",
  muted: "#929292",
  primary: "#b8b8b8",
  success: "#69c795",
  warning: "#d7a653",
  danger: "#e16d75",
} as const;

export const graphLaneColors = [palette.primary, palette.success, palette.warning, palette.danger] as const;

export const terminalPalette = {
  background: palette.surface,
  foreground: palette.foreground,
  cursor: palette.foreground,
  black: palette.canvas,
  red: palette.danger,
  green: palette.success,
  yellow: palette.warning,
  blue: palette.primary,
  magenta: palette.primary,
  cyan: palette.success,
  white: palette.foreground,
  brightBlack: palette.muted,
  brightRed: palette.danger,
  brightGreen: palette.success,
  brightYellow: palette.warning,
  brightBlue: palette.primary,
  brightMagenta: palette.primary,
  brightCyan: palette.success,
  brightWhite: "#ffffff",
} as const;
