import { useCallback, useEffect, useState } from "react";
import { fetchJevSettings, JEV_OFF, JEV_SETTINGS_EVENT, type JevSettingsPublic } from "./jev";

/** Server-side Jev settings; stays on "off" until the first fetch lands or if it fails. */
export function useJevSettings(): { settings: JevSettingsPublic; refresh: () => Promise<void> } {
  const [settings, setSettings] = useState<JevSettingsPublic>(JEV_OFF);
  const refresh = useCallback(async () => {
    try {
      setSettings(await fetchJevSettings());
    } catch {
      setSettings(JEV_OFF);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener(JEV_SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(JEV_SETTINGS_EVENT, onChange);
  }, [refresh]);
  return { settings, refresh };
}
