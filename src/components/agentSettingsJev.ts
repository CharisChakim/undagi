import { JEV_OFF, type JevSettingsPublic } from "../lib/jev";
import type { TFunction } from "../lib/i18n";

/** The four feature switches only work with Jev on and a key saved. */
export function jevFeaturesEditable(settings: Pick<JevSettingsPublic, "enabled" | "hasKey">): boolean {
  return settings.enabled && settings.hasKey;
}

/** Falls back to "off" when the server answers with something that is not the settings shape. */
export function jevOrOff(value: unknown): JevSettingsPublic {
  const candidate = value as Partial<JevSettingsPublic> | null | undefined;
  const valid =
    typeof candidate?.enabled === "boolean" &&
    typeof candidate.hasKey === "boolean" &&
    typeof candidate.features === "object" &&
    candidate.features !== null;
  return valid ? (candidate as JevSettingsPublic) : JEV_OFF;
}

export interface JevTestOutcome {
  ok: boolean;
  text: string;
}

/** Turns the /api/jev/test response into the one line shown next to the button. */
export function jevTestOutcome(
  result: { ok?: boolean; latencyMs?: number; error?: string } | null | undefined,
  t: TFunction,
): JevTestOutcome {
  if (!result?.ok) return { ok: false, text: result?.error?.trim() || t("Connection failed.") };
  const latency = result.latencyMs;
  if (typeof latency === "number" && Number.isFinite(latency)) {
    return { ok: true, text: t("Connected · {latencyMs} ms", { latencyMs: Math.round(latency) }) };
  }
  return { ok: true, text: t("Connected") };
}
