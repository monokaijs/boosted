// Keep these editor and browser chrome colors aligned with index.css.
export const palette = {
  canvas: "#101010",
  surface: "#181818",
  foreground: "#f2f2f2",
  muted: "#b4b4b4",
  primary: "#f9f9f9",
  success: "#40c977",
  warning: "#ffd240",
  danger: "#ff6764",
} as const;

export const lightPalette = {
  canvas: "#edf0f3",
  surface: "#ffffff",
  foreground: "#20242b",
  muted: "#626b77",
  primary: "#303842",
  success: "#23774b",
  warning: "#936018",
  danger: "#c13c48",
} as const;

export const themePalettes = { dark: palette, light: lightPalette } as const;

export const graphLaneColors = [palette.primary, palette.success, palette.warning, palette.danger] as const;
