// Teks yang bisa sampai ke layar pengguna, terpisah dari route yang memakainya.
// Log server sengaja tetap satu bahasa supaya mudah dicari.

// Bahasa antarmuka. Klien mengirimnya lewat body (endpoint POST) atau query
// (?lang=, untuk GET/DELETE riwayat). Yang tidak dikenali jatuh ke Inggris,
// bahasa bawaan aplikasi.
export type Lang = "en" | "id";

export const langOf = (req: any): Lang => ((req.body?.language ?? req.query?.lang) === "id" ? "id" : "en");

// Hanya pesan yang bisa muncul di layar pengguna yang diterjemahkan. Log server
// tetap satu bahasa supaya mudah dicari.
export const MESSAGES = {
  emptyResponse: { en: "The LLM returned an empty response.", id: "Respons LLM kosong." },
  jsonFailedLogged: {
    en: "Could not parse the JSON from the LLM: {detail}. The raw output is in the server log.",
    id: "Gagal memproses JSON dari LLM: {detail}. Output mentah ada di log server.",
  },
  jsonFailedRaw: {
    en: "Could not parse the JSON from the LLM: {detail}. Raw output: {raw}",
    id: "Gagal memproses JSON dari LLM: {detail}. Output mentah: {raw}",
  },
  baseUrlRequired: {
    en: "A base URL is required for a custom LLM / Ollama endpoint.",
    id: "Base URL endpoint LLM kustom / Ollama wajib diisi.",
  },
  customEndpointError: {
    en: "The custom LLM endpoint returned an error ({status}): {detail}",
    id: "Endpoint custom LLM mengembalikan error ({status}): {detail}",
  },
  customUnreachable: {
    en: "Could not reach the custom LLM / Ollama at {url}: {detail}. Check that the service is running and reachable.",
    id: "Gagal menghubungi Custom LLM / Ollama ({url}): {detail}. Pastikan service aktif dan terjangkau.",
  },
  geminiError: { en: "Error from the Gemini API: {detail}", id: "Error dari Gemini API: {detail}" },
  historyLoadFailed: { en: "Failed to load project history.", id: "Gagal memuat riwayat proyek." },
  sessionNotFound: { en: "Project session not found.", id: "Sesi proyek tidak ditemukan." },
  sessionLoadFailed: { en: "Failed to open the project session.", id: "Gagal memuat sesi proyek." },
  sessionIdMismatch: {
    en: "The session ID in the URL does not match the one in the body.",
    id: "ID sesi pada URL dan body tidak cocok.",
  },
  sessionSaveFailed: { en: "Failed to save the project session.", id: "Gagal menyimpan sesi proyek." },
  sessionDeleteFailed: { en: "Failed to delete the project session.", id: "Gagal menghapus sesi proyek." },
  followUpFailed: { en: "Failed to generate the follow-up questions.", id: "Gagal membuat pertanyaan follow-up." },
  planFailed: { en: "Failed to generate the project plan.", id: "Gagal membuat Project Plan." },
  prdFailed: { en: "Failed to generate the PRD.", id: "Gagal membuat PRD." },
  tasksFailed: { en: "Failed to generate the AI agent tasks.", id: "Gagal membuat AI Agent Tasks." },
  llmTimeout: {
    en: "No answer from the model within {minutes} minutes at {url}. The request was given up on, not refused — the model may simply be slower than that, or the endpoint may have stalled.",
    id: "Tidak ada jawaban dari model dalam {minutes} menit di {url}. Permintaan dihentikan sendiri, bukan ditolak — modelnya mungkin memang lebih lambat dari itu, atau endpoint-nya menggantung.",
  },
  stepNoStart: {
    en: "The model did not start writing within {minutes} minutes. It may still be thinking, which a high effort level can make slow, or the runtime may be stuck. Try again, or lower the effort.",
    id: "Model belum mulai menulis dalam {minutes} menit. Mungkin masih berpikir, yang bisa lama di tingkat effort tinggi, atau runtime-nya macet. Coba lagi, atau turunkan effort.",
  },
  stepStalled: {
    en: "The model stopped writing for {minutes} minutes in the middle of its answer, so the request was given up on. Try again.",
    id: "Model berhenti menulis selama {minutes} menit di tengah jawabannya, jadi permintaan dihentikan. Coba lagi.",
  },
  stepTooLong: {
    en: "This step ran for more than {minutes} minutes in total and was stopped. Try again, or pick a faster model.",
    id: "Langkah ini berjalan lebih dari {minutes} menit secara total dan dihentikan. Coba lagi, atau pilih model yang lebih cepat.",
  },
  outputTruncated: {
    en: "The model stopped before it finished writing — it hit its output limit. Try again, or switch to a model with a larger output budget.",
    id: "Model berhenti sebelum jawabannya selesai — batas panjang keluarannya tercapai. Coba lagi, atau pakai model dengan jatah keluaran lebih besar.",
  },
} as const;

// Error yang pesannya sudah ditujukan untuk pengguna. Penandanya dibutuhkan
// karena jalur Ollama/custom membungkus apa pun yang dilempar di dalamnya
// menjadi "tidak bisa dihubungi" — tanpa ini, sebab yang sebenarnya (endpoint
// menolak, jawaban terpotong) hilang di balik pesan yang salah.
export class LlmError extends Error {}

export const msg = (lang: Lang, key: keyof typeof MESSAGES, vars: Record<string, any> = {}): string =>
  MESSAGES[key][lang].replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));

// fetch() Node melempar Error bertuliskan "fetch failed" dan menaruh sebab
// sebenarnya — ECONNREFUSED, ECONNRESET, socket hang up — di err.cause.
// Tanpa dibuka, pesan ke pengguna tidak memberi tahu apa pun yang bisa
// ditindaklanjuti.
export function describeFetchError(err: any): string {
  const cause = err?.cause;
  const code = cause?.code || cause?.name;
  const detail = cause?.message || err?.message || String(err);
  return code && !detail.includes(code) ? `${code} (${detail})` : detail;
}
