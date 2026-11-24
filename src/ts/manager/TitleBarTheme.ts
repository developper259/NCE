export type ResolvedTheme = "dark" | "light";

export interface TitleBarOverlayTheme {
  readonly color: string;
  readonly symbolColor: string;
}

/**
 * The native Window Controls Overlay is painted by the OS on top of the web
 * contents, so a renderer-side modal scrim can never reach it. While a modal is
 * open the overlay therefore keeps its full-brightness color and reads as a
 * lighter block next to the scrimmed titlebar. The dimmed variant reproduces
 * what the scrim would have done to it: black at the scrim's alpha, composited
 * over the same colors.
 */
const MODAL_SCRIM_ALPHA = 0.55;

function dimColor(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const keep = 1 - MODAL_SCRIM_ALPHA;
  return `#${[value >> 16, (value >> 8) & 0xff, value & 0xff]
    .map((channel) =>
      Math.round(channel * keep)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function dimTheme(theme: TitleBarOverlayTheme): TitleBarOverlayTheme {
  return Object.freeze({
    color: dimColor(theme.color),
    symbolColor: dimColor(theme.symbolColor),
  });
}

export const TITLEBAR_OVERLAY_THEME: Readonly<
  Record<ResolvedTheme, TitleBarOverlayTheme>
> = Object.freeze({
  dark: Object.freeze({ color: "#141414", symbolColor: "#b8b8b8" }),
  light: Object.freeze({ color: "#e7e9ed", symbolColor: "#59636f" }),
});

export const TITLEBAR_OVERLAY_THEME_DIMMED: Readonly<
  Record<ResolvedTheme, TitleBarOverlayTheme>
> = Object.freeze({
  dark: dimTheme(TITLEBAR_OVERLAY_THEME.dark),
  light: dimTheme(TITLEBAR_OVERLAY_THEME.light),
});

export function titleBarOverlayFor(
  theme: ResolvedTheme,
  dimmed: boolean,
): TitleBarOverlayTheme {
  const palette = dimmed
    ? TITLEBAR_OVERLAY_THEME_DIMMED
    : TITLEBAR_OVERLAY_THEME;
  return palette[theme] ?? palette.dark;
}
