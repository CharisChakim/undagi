// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import express from "express";
import { bootScript, listPreferences, parsePreferenceWrite, PreferenceInputError, writePreferences } from "../preferences/store.ts";

const router = express.Router();

router.get("/api/preferences", (_req, res) => {
  try {
    res.json({ values: listPreferences() });
  } catch {
    res.status(500).json({ error: "PREFERENCES_READ_FAILED" });
  }
});

// Loaded by a <script> tag in index.html, before the page is drawn. An empty
// script, not an error, when the preferences cannot be read: the page then falls
// back to localStorage.
router.get("/api/prefs-boot.js", (_req, res) => {
  let script = "";
  try {
    script = bootScript(listPreferences());
  } catch {
    // Leave the script empty.
  }
  res.type("application/javascript").set("Cache-Control", "no-store").send(script);
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
