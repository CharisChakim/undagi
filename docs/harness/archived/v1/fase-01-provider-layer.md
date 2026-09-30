# Tugas: Fase 1 — provider layer agnostik

> Konteks besarnya ada di [`PLAN.md`](PLAN.md); aturan yang berlaku untuk semua fase
> ada di [`README.md`](README.md). Baca keduanya sebelum mulai.

Kamu bekerja di repo `undagi` (React 19 + Vite 6 di `src/`, Express 4 di `server.ts`, SQLite `node:sqlite` di `db.ts`, dijalankan lewat `tsx`). Node 24. Komentar di repo ini ditulis **Bahasa Indonesia** dan menjelaskan *kenapa*, bukan *apa* — ikuti gaya itu.

Ini bagian dari perombakan besar menjadi agent harness agnostik. **Kerjakan HANYA Fase 1 di bawah.** Jangan mengerjakan fase lain, jangan menyentuh UI, jangan menyentuh `agent.ts`.

## Yang sudah ada (hasil Fase 0, jangan diubah)

- `server/messages.ts` — `Lang`, `langOf`, `MESSAGES`, `LlmError`, `msg`, `describeFetchError`
- `server/llm/json.ts` — `looksTruncated`, `parseJsonFromLlm`

## Masalah yang diselesaikan Fase 1

`callLlm` di `server.ts` bercabang tiga (`gemini` / `ollama` / `custom`) dengan tiga bentuk request berbeda dan tiga cara deteksi truncation. `agent.ts` punya tumpukan sendiri yang terkunci ke `@anthropic-ai/sdk`. Fase 1 menaruh satu lapis adapter di bawah keduanya. Fase 1 hanya memindahkan `callLlm` ke atasnya; `agent.ts` menyusul di fase 3.

## File yang dibuat

```
server/llm/types.ts              model pesan netral + interface adapter
server/llm/url.ts                apiUrl()
server/llm/sse.ts                sseFrames()
server/llm/adapters/anthropic.ts
server/llm/adapters/openai.ts
server/llm/adapters/index.ts     getAdapter(format)
server/llm/call.ts               callLlm() non-streaming
server/llm/stream.ts             streamLlm() streaming
server/llm/models.ts             listModels()
server/llm/legacy.ts             legacyToConnection()
```

### `server/llm/types.ts` — pakai persis tipe ini

```ts
export type LlmFormat = "anthropic" | "openai";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface Message { role: "user" | "assistant"; content: ContentBlock[] }

/** JSON Schema polos. Adapter hanya mengganti nama fieldnya, tidak menulis ulang skemanya. */
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

export interface Connection {
  id: string;
  name: string;
  format: LlmFormat;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models: string[];
  jsonMode: boolean;
}

export interface LlmRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens: number;
  temperature?: number;
  jsonMode?: boolean;
  signal: AbortSignal;
}

export type StopReason = "stop" | "tool_calls" | "max_tokens" | "other";

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; parseError?: string }
  | { type: "done"; stop: StopReason };

export interface LlmResult {
  text: string;
  toolCalls: { id: string; name: string; input: unknown; parseError?: string }[];
  stop: StopReason;
}
```

Hasil tool disimpan di pesan `role:"user"` sebagai blok `tool_result` (pengelompokan ala Anthropic). Konsekuensinya pemetaan Anthropic hampir identitas dan pemetaan OpenAI jadi fan-out mekanis — itu disengaja, jangan dibalik.

### `server/llm/url.ts`

Aturan lama di `server.ts` (`openAiChatUrl`) end-anchored `/\/v\d+$/` sehingga pecah pada `…/v1beta/openai`. Ganti dengan:

```ts
const VERSIONED = /\/v\d[\w.-]*(\/|$)/;

export function apiUrl(baseUrl: string, suffix: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  if (root.endsWith("/" + suffix)) return root;
  return VERSIONED.test(root) ? `${root}/${suffix}` : `${root}/v1/${suffix}`;
}
```

Harus benar untuk semua ini — buat skrip cek sekali pakai untuk memastikan, lalu hapus skripnya:

| baseUrl | suffix | hasil |
|---|---|---|
| `http://localhost:20128/v1` | `messages` | `http://localhost:20128/v1/messages` |
| `https://api.anthropic.com` | `messages` | `https://api.anthropic.com/v1/messages` |
| `https://generativelanguage.googleapis.com/v1beta/openai` | `chat/completions` | `…/v1beta/openai/chat/completions` |
| `http://localhost:11434` | `chat/completions` | `http://localhost:11434/v1/chat/completions` |
| `https://openrouter.ai/api/v1` | `models` | `https://openrouter.ai/api/v1/models` |
| `https://x.test/v1/chat/completions` | `chat/completions` | tidak berubah |

Hapus `openAiChatUrl` dari `server.ts` setelah semua pemakaiannya pindah.

### `server/llm/sse.ts`

```ts
export interface SseFrame { event?: string; data: string }
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame>;
```

- `TextDecoder` mode `{ stream: true }`, simpan buffer antar-chunk.
- Pisah frame pada `\n\n` **dan** `\r\n\r\n`.
- Di dalam frame: baris diawali `:` adalah heartbeat → abaikan; `event:` masuk ke `event`; beberapa baris `data:` digabung dengan `\n`.
- Emit **semua** frame termasuk `data: [DONE]`. Mengenali terminator adalah tugas adapter, bukan parser.

Modul ini nanti dipakai ulang oleh transport MCP, jadi jangan menaruh apa pun yang khas LLM di sini.

### `server/llm/adapters/anthropic.ts`

Header: `content-type: application/json`, `x-api-key: <key>`, `anthropic-version: 2023-06-01`, lalu `conn.headers` di-merge **paling akhir** supaya router bisa menimpa.

Body: `{ model, max_tokens, system, messages, tools: tools.map(t => ({ name, description, input_schema: t.parameters })), stream }`.

**Jangan pernah mengirim `thinking`.** Di belakang router bisa ada model apa pun, dan yang tidak mendukungnya menolak dengan 400. Ini keputusan yang sudah ada di `agent.ts` dan dipertahankan.

Pemetaan blok keluar:
- `text` → `{type:"text", text}` — **buang blok yang teksnya kosong**, API menolak `""`.
- `tool_call` → `{type:"tool_use", id, name, input}`
- `tool_result` → `{type:"tool_result", tool_use_id: toolCallId, content, ...(isError && {is_error:true})}`

Akumulasi stream, keyed by index content-block:

| frame `event` | tindakan |
|---|---|
| `content_block_start` | daftarkan index dengan `content_block.type`, `.id`, `.name` |
| `content_block_delta` + `delta.type==="text_delta"` | yield `{type:"text", delta: delta.text}` |
| `content_block_delta` + `delta.type==="input_json_delta"` | `acc.json += delta.partial_json` |
| `content_block_delta` + `thinking_delta`/`signature_delta` | abaikan (router bisa mengirimnya meski tidak diminta) |
| `content_block_stop` | kalau `tool_use`: parse `json` (string kosong → `{}`), yield `tool_call` |
| `message_delta` | simpan `delta.stop_reason` |
| `event: error` | **lempar `LlmError(error.message)`** — error setelah HTTP 200 itu nyata, dan kalau diabaikan loop pemanggil menggantung selamanya |
| `message_stop` | yield `{type:"done", stop}` |

Pemetaan stop: `tool_use` → `tool_calls`, `max_tokens` → `max_tokens`, `end_turn`/`stop_sequence` → `stop`, sisanya `other`.

### `server/llm/adapters/openai.ts`

Header: `content-type: application/json`, `authorization: Bearer <key>` bila ada key, lalu `conn.headers` paling akhir.

Body: `{ model, messages, max_tokens, temperature?, stream, ...(tools && {tools: tools.map(t => ({type:"function", function:{name,description,parameters}}))}), ...(jsonMode && {response_format:{type:"json_object"}}) }`.

Pemetaan pesan keluar:
- `system` jadi pesan pertama `{role:"system", content}` — pakai `system`, bukan `developer`, karena `system` diterima di mana-mana.
- `role:"user"` berisi teks saja → `{role:"user", content: teksDigabung("\n")}`
- `role:"user"` berisi blok `tool_result` → fan-out **berurutan** jadi satu `{role:"tool", tool_call_id, content}` per hasil; blok teks di pesan yang sama jadi satu `{role:"user"}` di belakangnya.
- `role:"assistant"` → `{role:"assistant", content: text || null, ...(calls.length && {tool_calls: calls.map(c => ({id: c.id, type:"function", function:{name: c.name, arguments: JSON.stringify(c.input)}}))})}`

**Akumulasi stream keyed by `delta.tool_calls[].index` — ini bagian yang paling mudah salah, tulis persis begini:**

```ts
const idx = typeof tc.index === "number" ? tc.index : 0;   // sebagian gateway tidak mengirim index
const cur = acc.calls.get(idx) ?? { id: "", name: "", args: "" };
if (tc.id && !cur.id) cur.id = tc.id;
if (tc.function?.name && !cur.name) cur.name = tc.function.name;  // assign-once
if (tc.function?.arguments) cur.args += tc.function.arguments;    // selalu concat
acc.calls.set(idx, cur);
```

`name` **assign-once, jangan di-concat**: OpenAI mengirimnya sekali di fragment pertama, tapi beberapa gateway mengulangnya di setiap fragment — meng-concat menghasilkan `get_projectget_project`.

Saat `[DONE]` atau stream berakhir: urutkan `acc.calls` by index, `id` kosong diganti id acak. Tentukan stop:

```
ada tool call            -> "tool_calls"   // menang atas finish_reason; sebagian gateway melaporkan "stop" berbarengan dengan tool call
finish_reason === "length" -> "max_tokens"
finish_reason === "stop"   -> "stop"
selainnya                  -> "other"
```

Argumen yang gagal di-`JSON.parse` **tidak boleh** diam-diam jadi `{}`. Kembalikan `{ input: {}, parseError: <pesan> }` supaya pemanggil bisa menolak menjalankan tool itu. (Memalsukan `{}` untuk `write_file` yang rusak adalah cara mendapat file nol byte.)

### `server/llm/call.ts`

```ts
export async function callLlm(opts: {
  prompt: string; system: string; conn: Connection; model: string; lang: Lang;
  jsonMode?: boolean; maxTokens?: number; signal?: AbortSignal;
}): Promise<string>;
```

Non-streaming (`stream: false`). Wajib dipertahankan apa adanya dari `server.ts` lama:

- `LLM_TIMEOUT_MS = 300_000` → `AbortSignal.any([opts.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)].filter(Boolean))`
- `MAX_OUTPUT_TOKENS = 8192` sebagai default `maxTokens`
- `LlmError` dilempar untuk non-2xx (`customEndpointError`) dan untuk truncation (`outputTruncated`)
- `err.name === "TimeoutError"` → `msg(lang, "llmTimeout", { minutes, url })`
- kegagalan fetch lain → log rantai `cause` 4 tingkat **persis seperti sekarang** (blok `console.error` dengan `--- Panggilan LLM gagal ---`), tambahkan `format=` dan `connection=` pada baris pertamanya, lalu lempar `msg(lang, "customUnreachable", { url, detail: describeFetchError(err) })`. URL yang dilaporkan harus URL yang benar-benar dipanggil, bukan base URL.
- truncation: `LlmResult.stop === "max_tokens"` → `throw new LlmError(msg(lang, "outputTruncated"))`

**Risiko JSON mode:** llama.cpp, vLLM lama, dan sebagian router membalas 400 untuk `response_format` yang tidak dikenal. Dua mitigasi, keduanya wajib ada:
1. `Connection.jsonMode` — flag per koneksi.
2. Kalau percobaan pertama 400 **dan** body errornya menyebut `response_format`, ulangi **sekali** tanpa field itu.

Format `anthropic` tidak mengirim flag JSON sama sekali (Anthropic tidak punya JSON mode) — prompt sudah menyuruh "kembalikan PERSIS JSON berikut" dan `parseJsonFromLlm` adalah jaringnya.

### `server/llm/stream.ts`

```ts
export async function* streamLlm(conn: Connection, req: LlmRequest): AsyncGenerator<StreamEvent>;
```

`stream: true`, pipa `res.body` lewat `sseFrames`, lalu lewat `adapter.streamEvents`. Non-2xx dilempar sebagai `LlmError` dengan body-nya ikut. Belum ada pemakainya di fase ini — itu disengaja, fase 2 dan 3 yang memakainya.

### `server/llm/models.ts`

```ts
export async function listModels(conn: Connection): Promise<{ models: string[]; source: "remote" | "manual"; error?: string }>;
```

`GET apiUrl(conn.baseUrl, "models")` dengan header koneksi, timeout 10 detik. Anthropic dan OpenAI sama-sama membalas `{data:[{id,…}]}` → cukup satu parser: `json.data.map(m => String(m.id)).sort()`.

**Fungsi ini tidak boleh pernah `throw`.** Endpoint tanpa `/models` (llama.cpp, sebagian router) itu normal, bukan rusak — kembalikan `conn.models` dengan `source:"manual"` dan `error` berisi pesannya.

### `server/llm/legacy.ts`

```ts
export function legacyToConnection(cfg: any): { conn: Connection; model: string };
```

| `cfg.provider` | hasil |
|---|---|
| `"gemini"` / tidak ada | `format:"openai"`, `baseUrl:"https://generativelanguage.googleapis.com/v1beta/openai"`, `apiKey: cfg.apiKey?.trim() \|\| process.env.GEMINI_API_KEY`, `jsonMode:true`, model `cfg.modelName \|\| "gemini-3.6-flash"` |
| `"ollama"` | `format:"openai"`, `baseUrl: cfg.baseUrl \|\| "http://localhost:11434"`, `jsonMode:false`, model `cfg.modelName \|\| "llama3"` |
| `"custom"` | `format:"openai"`, `baseUrl: cfg.baseUrl`, `apiKey: cfg.apiKey`, `jsonMode:true`, model `cfg.modelName \|\| "gpt-3.5-turbo"` |

`custom` tanpa `baseUrl` tetap melempar `msg(lang, "baseUrlRequired")` seperti sekarang — pertahankan perilaku itu di `server.ts`.

Kalau tidak ada key Gemini sama sekali, pertahankan `console.warn` yang setara dengan yang ada di `getGeminiClient` sekarang (peringatan, bukan throw).

## Perubahan di `server.ts`

- Hapus `import { GoogleGenAI } from "@google/genai"` dan seluruh `getGeminiClient`.
- Hapus `openAiChatUrl`, `MAX_OUTPUT_TOKENS`, `LLM_TIMEOUT_MS` (pindah ke `server/llm/call.ts`).
- Ganti isi `callLlm` jadi pembungkus tipis. **Pertahankan signature-nya persis** — `callLlm(prompt, systemInstruction, llmConfig?, lang)` — supaya 5 titik pemanggilnya (baris ~253, 346, 553, 554, 676, 828) **tidak berubah satu karakter pun**:

```ts
async function callLlm(prompt: string, systemInstruction: string, llmConfig?: any, lang: Lang = "en"): Promise<string> {
  const { conn, model } = legacyToConnection(llmConfig);
  if (!conn.baseUrl) throw new Error(msg(lang, "baseUrlRequired"));
  return callLlmCore({ prompt, system: systemInstruction, conn, model, lang, jsonMode: conn.jsonMode });
}
```

- Buang `@google/genai` dari `package.json`.

## Yang TIDAK boleh disentuh

- `agent.ts` — sama sekali. Fase 3 yang mengurusnya.
- Semua prompt Bahasa Indonesia di `server.ts` (follow-up, plan, plan-resync, PRD, tasks) — **nol karakter berubah**, termasuk `DIAGRAM_RULES`, `AI_RULES`, dan `outputLanguage`.
- `server/llm/json.ts` dan `server/messages.ts`.
- Post-processing tiap route (koersi `subFeatures`, renumber `additionalSections`, alias legacy PRD, `status ??= "todo"`).
- Apa pun di `src/`.
- Jangan menambah dependency baru. Pakai `fetch` bawaan Node.
- Jangan memformat ulang file, jangan merapikan kode di sebelah yang tidak diminta.

## Selesai kalau

1. `npm run lint` (yaitu `tsc --noEmit`) bersih.
2. `npm run build` berhasil.
3. `node_modules/@google/genai` tidak lagi diimpor dari mana pun (`grep -rn "@google/genai" server.ts src/ server/` kosong).
4. `grep -rn "callLlm(" server.ts` menunjukkan 5 titik panggil yang **tidak berubah**.
5. Tabel `apiUrl` di atas terverifikasi.
6. `git diff --stat` tidak menyentuh `agent.ts` maupun `src/`.

Kalau ada yang ambigu atau kamu menemukan sesuatu yang bertentangan dengan brief ini, **berhenti dan laporkan**, jangan menebak. Di akhir, tulis ringkasan singkat: file yang dibuat, yang diubah, keputusan yang kamu ambil sendiri, dan apa yang belum terverifikasi.
