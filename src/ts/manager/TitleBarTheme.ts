export type ResolvedTheme = "dark" | "light";

export interface TitleBarOverlayTheme {
  readonly color: string;
  readonly symbolColor: string;
}

export const TITLEBAR_OVERLAY_THEME: Readonly<
  Record<ResolvedTheme, TitleBarOverlayTheme>
> = Object.freeze({
  dark: Object.freeze({ color: "#141414", symbolColor: "#b8b8b8" }),
  light: Object.freeze({ color: "#e7e9ed", symbolColor: "#59636f" }),
});
