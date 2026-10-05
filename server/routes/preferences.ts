import express from "express";
import { listPreferences, parsePreferenceWrite, PreferenceInputError, writePreferences } from "../preferences/store.ts";

const router = express.Router();

router.get("/api/preferences", (_req, res) => {
  try {
    res.json({ values: listPreferences() });
  } catch {
    res.status(500).json({ error: "PREFERENCES_READ_FAILED" });
  }
});

router.put("/api/preferences", (req, res) => {
  let values: Record<string, string | null>;
  try {
    values = parsePreferenceWrite(req.body);
  } catch (error) {
    res.status(400).json({ error: error instanceof PreferenceInputError ? error.code : "PREFERENCES_INVALID" });
    return;
  }
  try {
    writePreferences(values);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: "PREFERENCES_WRITE_FAILED" });
  }
});

export { router };
export default router;
