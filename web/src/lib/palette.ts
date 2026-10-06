// Keep these editor and browser chrome colors aligned with index.css.
export const palette = {
  canvas: "#08090b",
  surface: "#0e1013",
  foreground: "#e7e9ed",
  muted: "#959da9",
  primary: "#c6cbd3",
  success: "#72ce9d",
  warning: "#ddb66f",
  danger: "#ee7d86",
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
