// Copyright (c) 2026 Charis Chakim - Undagi (https://github.com/CharisChakim/undagi)
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { Lang, msg } from "../messages.ts";

// Menyelamatkan JSON dari keluaran model: buang pagar markdown, potong dari
// kurung pertama sampai terakhir, perbaiki koma menggantung. Dipindah utuh
// dari server.ts — perilakunya tidak berubah.

// Jawaban yang terpotong tetap berupa JSON yang "hampir benar", jadi kalau
// tidak dikenali di sini pesan yang sampai ke pengguna adalah keluhan sintaks
// di posisi sekian — menyesatkan, karena yang salah bukan bentuknya melainkan
// panjangnya. Kurung yang tidak seimbang adalah tanda paling andal.
export function looksTruncated(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth > 0 || inString;
}

// Helper function to extract and parse JSON safely
export function parseJsonFromLlm(text: string, lang: Lang = "en"): any {
  if (!text) throw new Error(msg(lang, "emptyResponse"));
  let cleaned = text.trim();
  
  // Remove markdown code fence if present
  if (cleaned.startsWith("```")) {
    const firstLineEnd = cleaned.indexOf("\n");
    if (firstLineEnd !== -1) {
      cleaned = cleaned.substring(firstLineEnd + 1);
    }
    if (cleaned.endsWith("```")) {
      cleaned = cleaned.substring(0, cleaned.length - 3);
    }
  }
  
  cleaned = cleaned.trim();
  
  try {
    return JSON.parse(cleaned);
  } catch (err: any) {
    // Ambil dari '{' atau '[' pertama sampai penutup terakhir, lalu buang koma
    // menggantung — model yang lebih lemah sering menyisakannya sebelum } atau ].
    const firstBrace = cleaned.search(/[\{\[]/);
    const lastBrace = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const extracted = cleaned.substring(firstBrace, lastBrace + 1).replace(/,(\s*[}\]])/g, "$1");
      try {
        return JSON.parse(extracted);
      } catch (retryErr: any) {
        // Output penuh ke log server: pesan ke pengguna harus tetap ringkas,
        // tapi tanpa teks aslinya kegagalan ini tidak bisa didiagnosis.
        console.error("--- Output LLM yang gagal diparse ---\n" + cleaned + "\n--- akhir output ---");
        if (looksTruncated(cleaned)) throw new Error(msg(lang, "outputTruncated"));
        throw new Error(msg(lang, "jsonFailedLogged", { detail: retryErr.message }));
      }
    }
    if (looksTruncated(cleaned)) throw new Error(msg(lang, "outputTruncated"));
    throw new Error(msg(lang, "jsonFailedRaw", { detail: err.message, raw: cleaned.substring(0, 400) }));
  }
}
