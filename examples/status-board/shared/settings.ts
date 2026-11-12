import { device } from "@shared/device";
import manifest from "../src/appmeta/manifest.json";

/** Stored values: a flat field id → value map, as src/appmeta/settings.json names the fields. */
export type SettingsValues = Record<string, unknown>;

/**
 * Reads the values the person saved on the app's settings page (the bar's web page → Apps → this app), or null when
 * the bar does not answer.
 *
 * The official template's version of this file reads a global `Settings` that firmware 1.3.1 does not have, so there
 * `loadValues()` is always null. This one asks the bar's HTTP API, which an app may do for its own id. The app reads
 * its settings once, at its start: after saving, the settings page offers to restart the app.
 */
export async function loadValues(): Promise<SettingsValues | null> {
  try {
    const document = await device.AppsSettingsGet({ app_id: manifest.id });
    return (document.values ?? null) as SettingsValues | null;
  } catch (err) {
    console.error(`${manifest.id}: settings unavailable, using the defaults: ${String(err)}`);
    return null;
  }
}

/** A whole number within [min, max], or the fallback. */
export function integer(values: SettingsValues | null, key: string, fallback: number, min: number, max: number): number {
  const value = values?.[key];
  return typeof value === "number" && isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/** A text, trimmed, or the fallback when it is missing. */
export function text(values: SettingsValues | null, key: string, fallback: string): string {
  const value = values?.[key];
  return typeof value === "string" ? value.trim() : fallback;
}

/** A switch. */
export function flag(values: SettingsValues | null, key: string, fallback: boolean): boolean {
  const value = values?.[key];
  return typeof value === "boolean" ? value : fallback;
}

/** One of the options of an enum field, or the fallback. */
export function choice<T extends string>(values: SettingsValues | null, key: string, options: readonly T[], fallback: T): T {
  const value = values?.[key];
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A color field as the display takes it, #RRGGBBAA; the settings page stores #RRGGBB or #RRGGBBAA. */
export function color(values: SettingsValues | null, key: string, fallback: string): string {
  const value = values?.[key];
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) return fallback;
  return (value.length === 7 ? `${value}FF` : value).toUpperCase();
}
