# Rombak Undagi → Agent Harness Agnostik

## Context

Aplikasi ini sekarang punya **dua tumpukan LLM yang tidak saling kenal**:

- `callLlm` (`server.ts:198-322`) — tiga cabang provider (`gemini`/`ollama`/`custom`), sekali tembak, tanpa tool, JSON dibujuk lewat prompt lalu diselamatkan `parseJsonFromLlm`. Melayani 4 route generate.
- `runAgent` (`agent.ts`) — loop tool sungguhan, tapi **terkunci ke Anthropic SDK**. Panel chat mengirim `baseUrl`/`apiKey`/`modelName` dari LLM settings ke klien Anthropic sambil **membuang field `provider`** (`ChatPanel.tsx:99-103`). Pilih Gemini di modal → agent menerima key Gemini sebagai kredensial Anthropic. Ini bug hidup, bukan hipotesis.

Akibatnya: ganti model = mengedit satu config global yang artinya berbeda tergantung endpoint mana yang membacanya; menyambung langganan lain harus lewat router yang kebetulan bicara format Anthropic.

**Yang ingin dicapai:** aplikasi jadi harness agent seperti umumnya — chat sebagai permukaan utama, tool call terlihat, diff dan output perintah terbaca — sementara alur Plan → PRD → Tasks tetap tampak di sebelahnya dan **bisa dibaca serta dijalankan oleh agent**, sehingga agent mengacu pada plan yang sudah dirancang. Koneksi ke model mana pun harus mudah (preset dua klik), ganti model tanpa buka modal, MCP didukung, dan aplikasi berjalan lebih ringan.

**Keputusan yang sudah diambil bersama pengguna (tidak dibahas ulang):** tech stack tetap React + Vite + Express — diet berat, bukan rewrite. Agent dapat tool coding sungguhan. MCP masuk. Provider bersifat opsional, pengguna memilih sendiri mana yang disambungkan. **UI/UX boleh diubah bila perlu** — batas "sentuh tiga file step seminimal mungkin" dicabut, dan tiga perubahan di Bagian I menjadi konsekuensinya.

---

## Arsitektur sasaran

```
                        ┌─ server/llm/adapters/anthropic.ts ─┐
  route generate ──┐    │                                     │──→ fetch + SSE
  agent loop ──────┼──→ │ server/llm/{types,url,sse,call,stream}
  MCP tool ────────┘    │                                     │
                        └─ server/llm/adapters/openai.ts ─────┘

  connections (SQLite) ──→ role bindings: agent | plan | prd | tasks
```

Satu model pesan netral menggantikan blob ber-bentuk-Anthropic yang sekarang bolak-balik lewat browser. Adapter hanya memetakan keluar; stream didekode langsung ke blok netral. Konsekuensinya **ganti provider di tengah percakapan jadi mungkin** — hari ini tidak.

---

## Keputusan kunci (satu baris masing-masing)

1. **Buang `@anthropic-ai/sdk` dan `@google/genai`.** Raw `fetch` + parser SSE sendiri. Sekaligus mematikan footgun `baseURL + "/v1/messages"` yang membuat `…/v1` jadi `/v1/v1/messages`.
2. **Gemini lewat endpoint OpenAI-compat** (`generativelanguage.googleapis.com/v1beta/openai`) — mendukung tools dan `response_format`, satu adapter lebih sedikit.
3. **Buang cabang native Ollama** (`/api/generate`) — Ollama sudah punya `/v1/chat/completions` dengan tool sejak 0.1.24; cabang kedua tanpa tool tidak membeli apa-apa.
4. **API key disimpan di SQLite**, dengan escape hatch `api_key_env`. Harness yang tidak bisa bertindak tanpa tab browser terbuka bukan harness. Butuh konfirmasi Anda — lihat §Butuh review.
5. **Percakapan pindah ke SQLite.** History berhenti bolak-balik lewat browser; transcript selamat dari reload.
6. **`edit_file` = exact match + cek keunikan, all-or-nothing, tanpa fallback fuzzy.** Gagal keras dengan jumlah kemunculan mengajari model melebarkan konteks; fuzzy matching adalah tempat tool semacam ini membusuk.
7. **`grep`/`glob` di Node, bukan ripgrep.** `fs.promises.glob` sudah terverifikasi jalan di Node 24.15 dan memangkas `node_modules` saat traversal — tanpa dependency, tanpa gagal-karena-binary-tidak-ada.
8. **MCP client ditulis tangan** (~250 baris untuk subset initialize/tools-list/tools-call). SDK resmi menarik zod dkk, melawan diet.
9. **`llmConfig` lama tetap diterima selamanya** lewat `legacyToConnection()` — 4 route generate tidak butuh perubahan klien.

---

## Bagian A — Provider layer (server)

### File baru

```
server/messages.ts              pindahan: Lang, MESSAGES, msg, LlmError, describeFetchError
server/llm/types.ts             model netral + interface adapter
server/llm/url.ts               apiUrl() — generalisasi openAiChatUrl
server/llm/sse.ts               sseFrames() — dipakai adapter LLM DAN transport MCP
server/llm/json.ts              pindahan verbatim: looksTruncated, parseJsonFromLlm
server/llm/adapters/{anthropic,openai,index}.ts
server/llm/call.ts              callLlm() non-streaming + JSON mode + salvage
server/llm/stream.ts            streamLlm() streaming
server/llm/models.ts            listModels()
server/llm/legacy.ts            legacyToConnection(LLMConfig) → Connection
```

### Tipe netral (`server/llm/types.ts`)

```ts
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export interface Message { role: "user" | "assistant"; content: ContentBlock[] }

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

export interface Connection {
  id: string; name: string; format: "anthropic" | "openai";
  baseUrl: string; apiKey?: string; headers?: Record<string, string>;
  models: string[]; jsonMode: boolean;
}

export type StopReason = "stop" | "tool_calls" | "max_tokens" | "other";
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown; parseError?: string }
  | { type: "done"; stop: StopReason };
```

Hasil tool ditaruh di pesan `role:"user"` sebagai blok `tool_result` (pengelompokan ala Anthropic) → pemetaan Anthropic hampir identitas, pemetaan OpenAI jadi fan-out mekanis.

### Normalisasi URL (`server/llm/url.ts`)

Aturan lama end-anchored (`/\/v\d+$/`, `server.ts:190-195`) pecah pada `…/v1beta/openai`. Ganti:

```ts
const VERSIONED = /\/v\d[\w.-]*(\/|$)/;
export function apiUrl(baseUrl: string, suffix: string): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  if (root.endsWith("/" + suffix)) return root;
  return VERSIONED.test(root) ? `${root}/${suffix}` : `${root}/v1/${suffix}`;
}
```

Terverifikasi terhadap: `localhost:20128/v1`, `api.anthropic.com`, `…/v1beta/openai`, `localhost:11434`, `openrouter.ai/api/v1`.

### Akumulasi stream — bagian yang paling mudah salah

**Anthropic**, keyed by index blok: `content_block_start` daftarkan index → `text_delta` yield teks → `input_json_delta` akumulasi `partial_json` → `content_block_stop` parse dan yield `tool_call` → `message_delta` simpan `stop_reason`. Frame `event: error` **harus di-throw** — error setelah HTTP 200 itu nyata dan kalau diabaikan loop menggantung selamanya. `thinking` tetap tidak pernah dikirim (alasan di `agent.ts:414-415` masih berlaku).

**OpenAI**, keyed by `delta.tool_calls[].index`:

```ts
const idx = typeof tc.index === "number" ? tc.index : 0;   // sebagian gateway tidak mengirim index
const cur = acc.calls.get(idx) ?? { id: "", name: "", args: "" };
if (tc.id && !cur.id) cur.id = tc.id;
if (tc.function?.name && !cur.name) cur.name = tc.function.name;  // assign-once, JANGAN concat
if (tc.function?.arguments) cur.args += tc.function.arguments;    // selalu concat
```

`name` assign-once karena beberapa gateway mengulangnya tiap fragment → concat menghasilkan `get_projectget_project`. `stop`: adanya tool call menang atas `finish_reason` (sebagian gateway melaporkan `"stop"` berbarengan dengan tool call).

**Argumen JSON tidak valid → tool TIDAK dieksekusi.** Kembalikan `tool_result` berisi `{error:"Arguments were not valid JSON: …"}`. Memalsukan `{}` untuk `write_file` yang rusak adalah cara mendapat file nol byte.

### Yang dipertahankan dari `callLlm`

`LlmError` sentinel, tabel `MESSAGES` dwibahasa, `describeFetchError` + dump rantai cause 4-level, `parseJsonFromLlm` + `looksTruncated` **verbatim beserta komentarnya**, timeout 300 detik (`AbortSignal.any([signal, AbortSignal.timeout(...)])`), deteksi truncation (`finish_reason==="length"` → `LlmError(outputTruncated)`).

**Risiko JSON mode, dinyatakan:** llama.cpp, vLLM lama, dan sebagian router mengembalikan 400 untuk `response_format` yang tidak dikenal. Mitigasi: flag `jsonMode` per koneksi + retry sekali tanpa `response_format` bila 400-nya menyebut field itu. Format `anthropic` tidak mengirim flag JSON sama sekali — prompt sudah menyuruh "kembalikan PERSIS JSON berikut" dan `parseJsonFromLlm` adalah jaringnya.

---

## Bagian B — Koneksi bernama & routing model

### Skema (`server/connections/store.ts`, `CREATE TABLE IF NOT EXISTS`)

```sql
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL,
  base_url TEXT NOT NULL, api_key TEXT NOT NULL DEFAULT '',
  api_key_env TEXT NOT NULL DEFAULT '',        -- process.env[...] menang atas api_key
  headers TEXT NOT NULL DEFAULT '{}', models TEXT NOT NULL DEFAULT '[]',
  json_mode INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL );

CREATE TABLE IF NOT EXISTS role_bindings (
  role TEXT PRIMARY KEY,            -- 'agent' | 'plan' | 'prd' | 'tasks'
  connection_id TEXT NOT NULL, model TEXT NOT NULL );
```

Key **tidak pernah keluar dari server**: `GET /api/connections` mengembalikan `hasKey: boolean`. Saat menulis, `apiKey: null` = pertahankan, `""` = hapus.

**Urutan resolusi:** `body.connectionId+model` → `body.llmConfig` (legacy, ephemeral) → `role_bindings[role]` → satu-satunya koneksi yang ada → error yang menyebut apa yang kurang. Urutan role-sebelum-legacy penting: begitu pengguna menyimpan satu koneksi, **ChatPanel lama yang belum disentuh langsung me-routing dengan benar**.

### Penemuan model (`server/llm/models.ts`)

`GET apiUrl(baseUrl, "models")`, timeout 10 detik. Anthropic dan OpenAI sama-sama mengembalikan `{data:[{id,…}]}` → satu parser. **Tidak pernah throw**: endpoint tanpa `/models` (llama.cpp, sebagian router) itu normal, bukan rusak — kembalikan daftar manual tersimpan.

### Test koneksi — tiga probe

`POST /api/test-llm` hari ini hanya menguji jalur JSON non-streaming, jadi **lulus untuk endpoint yang agent-nya tidak bisa dipakai**. Ganti dengan:

1. `models` — informasional, gagal tidak menggagalkan.
2. `chat` — satu giliran **streaming** sungguhan, `maxTokens: 64`. Ini yang menguji parsing SSE dan normalisasi base URL — dua hal yang benar-benar patah. Gagal = fatal.
3. `tools` — giliran yang sama dengan satu tool sepele `ping`, memastikan `tool_call` sampai dan ter-parse. **Probe inilah yang memisahkan "endpoint menjawab" dari "endpoint bisa menjalankan agent".** Gagal → `ok:true, toolsSupported:false` (koneksi yang hanya diikat ke plan/prd/tasks tidak butuh tool).

Route: `GET|POST /api/connections`, `PUT|DELETE /:id`, `POST /:id/models`, `POST /:id/test`, `POST /test` (draft), `PUT /api/roles`. `POST /api/test-llm` jadi alias tipis agar modal lama tetap hidup.

---

## Bagian C — Agent loop provider-netral

### Persistensi percakapan (`server/agent/conversations.ts`)

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL );
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL );
```

**Tabel `sessions` tidak disentuh. Tanpa migrasi. Sesi tersimpan tetap jalan.**

`sanitize()` jalan sebelum **setiap** request: `tool_call` tanpa `tool_result` pasangannya disintesis jadi `{error:"Turn was interrupted."}`. Kedua API menolak keras tool call yang tak terjawab — ini yang membuat abort bisa dipulihkan dan pergantian provider di tengah percakapan aman.

### Loop

Properti yang **wajib dipertahankan** dari `agent.ts`:

- **Gating ketersediaan** (`agent.ts:345-352`) — tool yang tidak diizinkan tidak pernah ditawarkan, jadi model tidak menyusun rencana di sekitar kemampuan yang tidak ada.
- **Re-check saat dispatch** (`agent.ts:283-289`) — daftar dibangun sekali per giliran, izin bisa dicabut di tengah.
- **`resolveInsideRoot`** (`agent.ts:49-71`) pindah verbatim ke `server/agent/sandbox.ts`. Semua tool fs lewat sini, termasuk tiap path yang dikembalikan `glob`.
- **Approval sebelum eksekusi**, **error sebagai result** bukan throw.
- **Semua `tool_result` satu giliran pulang dalam SATU pesan user** (alasan di `agent.ts:436-437`).

Knob jadi konfigurabel lewat `session.agentLimits` (payload sudah blob JSON, nol kerja skema): `maxTurns` 12, `maxTokens` 8000, `maxReadChars` 60k, `maxOutputChars` 20k, `commandTimeoutMs` 120s.

**Pesan assistant dipersist begitu stream selesai, sebelum tool mana pun jalan** — abort saat `run_command` panjang tidak boleh menghilangkan giliran assistant.

### Transport (`server/routes/agent.ts`)

Yang hari ini sama sekali tidak ada:

```ts
const ac = new AbortController();
req.on("close", () => ac.abort(new Error("client disconnected")));
```

Disalurkan ke: fetch provider, tunggu approval (abort → settle `false`), `execFile` (`{signal}` membunuh child), tiap awal giliran, tiap dispatch. `send()` dapat guard `if (res.writableEnded || ac.signal.aborted) return;` — tanpa itu `res.write` ke socket mati melempar dari dalam loop. Tambah heartbeat `: ping\n\n` tiap 15 detik.

`pendingApprovals` jadi `Map<string, {convId, settle}>` dan `/api/agent/approve` memeriksa `convId`. Dinyatakan jujur: **ini bukan batas keamanan** di app single-user localhost — pelindung sesungguhnya adalah nonce yang tidak bisa ditebak — tapi satu baris dan mencegah tab basi menjawab prompt orang lain.

### Kanal approval digeneralisasi jadi kanal elicitation

`askApproval` sudah melakukan hal yang persis dibutuhkan untuk menanyakan apa pun ke pengguna di tengah tool: kirim permintaan lewat SSE, tahan promise, tunggu POST balasan, timeout jadi penolakan. Naikkan satu tingkat:

```ts
export type Elicit = (req:
  | { kind: "approval"; command: string; cwd?: string }
  | { kind: "questions"; questions: FollowUpQuestion[]; round: number }
) => Promise<unknown>;
```

`run_command` memakai `kind:"approval"` (perilaku identik dengan hari ini). Tool `ask_followups` di Bagian D memakai `kind:"questions"`. Biayanya ~30 baris server dan satu renderer kartu tambahan di klien, dan inilah yang membuat pertanyaan klarifikasi bisa hidup di dalam transcript alih-alih di layar form terpisah — pondasi Bagian I.1. `POST /api/agent/approve` jadi `POST /api/agent/respond` dengan body `{elicitId, conversationId, response}`; endpoint lama tetap sebagai alias satu rilis supaya ChatPanel lama tidak 404.

### Event tambahan untuk UI

`tool_start`/`tool_done` **wajib membawa `id` stabil** (`block.id` sudah di tangan di `agent.ts:440`). Hari ini `ChatPanel.tsx:140` memasangkan hasil dengan "entri terakhir yang masih running" — dengan dua tool paralel, hasil mendarat di kartu yang salah. Bug hidup.

Bentuk result yang dikontrakkan ke UI:
- `run_command` → `{command, stdout, stderr, exitCode}`
- `edit_file` → `{path, patch}` dengan `patch` berupa teks unified-diff

---

## Bagian D — Alur PRD sebagai tool agent ⟵ permintaan utama

Ini yang membuat "agent mengacu ke plan yang sudah didesain" benar-benar bekerja. Keempat route generate direfaktor: logikanya (prompt + `callLlm` + `parseJsonFromLlm` + post-processing) diekstrak jadi fungsi murni di `server/pipeline/{plan,prd,tasks}.ts`; route jadi pembungkus tipis. **Prompt Indonesia dan logika salvage-nya tidak berubah satu karakter pun.**

Fungsi yang sama lalu dipasang sebagai tool di `server/agent/tools/pipeline.ts`:

| Tool | Isi |
|---|---|
| `get_plan` | `plan.summary`, `specs` (fitur + tech stack), `architectureDraft`, `roadmap`, `estimation` |
| `get_prd` | 7 poin + `additionalSections`, atau penanda "PRD belum dibuat" |
| `get_tasks` | papan penuh: id, phase, priority, targetFiles, dependencies, status |
| `ask_followups` | jalankan `/api/followup-questions`, **tampilkan pertanyaannya sebagai kartu interaktif di transcript** lewat kanal elicitation, kembalikan jawaban pengguna |
| `generate_plan` | jalankan pipeline plan dari deskripsi + jawaban follow-up, tulis ke sesi |
| `generate_prd` | jalankan pipeline PRD dari plan yang ada, tulis ke sesi |
| `generate_tasks` | jalankan pipeline tasks dari PRD, tulis ke sesi |
| `set_task_status` | sudah ada (`agent.ts:194`) |

`get_project` yang sekarang hanya mengembalikan `{title, currentStep, summary, features, hasPrd, tasks[id,title,status]}` — terlalu tipis untuk agent yang harus mengeksekusi task. Tiga tool baca di atas menutup celah itu tanpa membengkakkan satu response.

Model untuk `generate_prd`/`generate_tasks` diambil dari `role_bindings.prd`/`.tasks` — jadi agent bisa berjalan di model kuat sementara generasi PRD di model murah.

---

## Bagian E — Tool coding

Semua lewat `resolveInsideRoot`. Deskripsi tetap Bahasa Indonesia, seragam dengan tool yang ada.

**`glob`** — `{pattern, dir?, limit?}`. `fs.promises.glob` dengan `exclude` sebagai fungsi yang memangkas `node_modules|.git|dist|build|coverage|.next|.venv`. Terukur di repo ini: `**/*.ts` → 11 file dalam 15 ms dengan `node_modules` terpasang. Cap 200, urut mtime desc.

**`grep`** — `{pattern, path?, glob?, ignoreCase?, maxMatches?, contextLines?}`. Node murni. Lewati file > 2 MB dan file biner (byte NUL di 8 KB pertama). RegExp dibangun dalam try/catch. Cap: 200 total, 20 per file, baris dipotong 300 char, budget wall-clock dicek tiap 500 file.
*Risiko diterima:* pola dengan catastrophic backtracking memblokir event loop dan budget tidak bisa menginterupsi satu `.test()`. Di app localhost single-user ini menggantung satu giliran. Pengerasan (worker thread) sengaja tidak dibangun.

**`edit_file`** — `{file, edits: [{oldText, newText, replaceAll?}]}`. Menggantikan `write_file` sebagai jalur yang diiklankan.

1. Baca file penuh (terpotong = error keras).
2. Tiap edit berurutan terhadap buffer yang terus diperbarui:
   - `oldText === ""` → tolak (sisip-di-0 ambigu)
   - 0 kemunculan → tolak, sertakan hint "salin ulang dari read_file termasuk spasi dan indentasi"
   - >1 kemunculan tanpa `replaceAll` → tolak, **sertakan jumlah dan nomor barisnya** supaya model melebarkan `oldText`
3. Penolakan apa pun **membatalkan seluruh panggilan, file tidak ditulis** — tidak pernah ada multi-edit setengah jadi.
4. Kembalikan `{ok, file, editsApplied, bytes, patch}`.

Tanpa fallback fuzzy/normalisasi whitespace: model baru saja membaca file itu, jadi gagal exact-match berarti dia menebak, dan jumlah kemunculan adalah umpan balik yang memperbaikinya. `write_file` tetap ada (membuat file baru sah) tapi deskripsinya ditulis ulang jadi "untuk file baru atau penulisan ulang yang disengaja". Ini sekaligus membuat flag `truncated:true` milik `read_file` jadi berguna, bukan sekadar informatif.

**`read_files`** — maks 10 file, budget per file `maxReadChars / jumlah`, tiap entri punya `error?` sendiri. `read_file` dapat `startLine`/`endLine` opsional.

---

## Bagian F — MCP client

Subset: `initialize` (protokol `2025-06-18`) → `notifications/initialized` → `tools/list` (ikuti `nextCursor`) → `tools/call`.

- **stdio** — `spawn`, **newline-delimited JSON, bukan framing `Content-Length` ala LSP** (ini kesalahan klasiknya). stderr ke log + ring buffer 50 baris untuk UI.
- **streamable HTTP** — POST dengan `accept: application/json, text/event-stream`, header `Mcp-Session-Id` setelah server memberinya. Respons SSE **memakai ulang `server/llm/sse.ts`**. Tidak diimplementasi: GET listening stream, resumability, transport lama 2024-11-05.
- **Lifecycle** — connect malas pada giliran pertama yang butuh tool, lalu keep-alive dengan reaper idle 10 menit. **Tidak pernah connect saat boot** — startup tidak boleh bergantung pada unduhan `npx`.
- **Tabrakan nama** — `mcp__<server>__<tool>`, disanitasi ke `[a-zA-Z0-9_-]`, dipotong 64 char (OpenAI membatasi di situ). Built-in selalu menang. Total tool dicap 100.
- **Saat server mati** — `tools/list` paralel dengan budget 1500 ms per server; server mati menyumbang nol tool dan satu event `mcp_status`, **giliran tetap jalan**. Memanggil tool dari server yang sudah mati → `{error:...}`, model memutar arah. stdio yang keluar ditandai `crashed` + stderr terakhir, retry sekali dengan backoff 30 detik.

Sengaja tidak dibangun: sampling, roots, elicitation, prompts, resources.

---

## Bagian G — Shell UI

### Layout

```
┌ Rail ─────┬─────────────── Workbench ──────────────────────────┐
│ ● Agent   │ Topbar: judul · [Agent|Split|Board] · ●conn·model ▾ │
│ 1 Plan  ✓ ├──────────────────────┬─────────────────────────────┤
│ 2 PRD   ✓ │ AgentPane            ║ PipelinePane                │
│ 3 Tasks 🔒│  transcript          ║  [Plan][PRD][Tasks]         │
│           │  📁 ~/code/app ⇧shell║  @container/pane            │
│ ●conn·mdl │  composer ▸          ║  <Step1|Step2|Step3>        │
└───────────┴──────────────────────╨─────────────────────────────┘
```

Agent di kiri (permukaan yang diketik), pipeline di kanan (yang dihasilkan), split default 42/58. Tiga mode disimpan di localStorage: `split` (default >1100px), `agent` (pipeline mengecil jadi strip chip `Plan ✓ · PRD ✓ · Tasks 4/12`), `board` (agent mengecil jadi pill). Di bawah 1100px `split` jatuh ke `agent`/`board`. **Ini menggantikan seluruh tarian `fixed inset-y-0 right-0 … lg:static lg:w-96` milik ChatPanel.**

Splitter ditulis tangan (~40 baris, `setPointerCapture`, `role="separator"`, panah ±2%). Tanpa library.

### Routing: +6 baris

`STEP_PATHS` tidak berubah — `/plan` `/prd` `/tasks` tetap jalan, bookmark selamat. URL sekarang berarti "tab mana yang ditampilkan pipeline", bukan "halaman mana". Tambah `AGENT_PATH = "/"`; `pathToStep("/")` sudah mengembalikan `null` → App jatuh ke `session.currentStep`.

### Transcript yang terbaca

Hari ini `tool_start.input` dan `tool_done.result` **diterima lalu dibuang** (`ChatPanel.tsx:135-145`) — dan seluruh percakapan hancur setiap panel ditutup (`ChatPanel.tsx:176`: `if (!open) return null`). Keduanya cacat nyata untuk sebuah harness.

`src/lib/useAgentRun.ts` mengangkat semua logika keluar dari komponen. Parsing SSE (`ChatPanel.tsx:108-126`) pindah **tanpa diubah** — buffering `split("\n\n")` + tahan ekor itu sudah benar. `history.current` tetap `useRef<unknown[]>` yang opak (komentar `ChatPanel.tsx:6-8` harus ikut verbatim).

Registry renderer `name → renderer` dengan fallback generik, karena nama tool MCP tidak diketahui saat build:

| Tool | Judul ringkas | Isi |
|---|---|---|
| `read_file` | `Read src/App.tsx` | 30 baris pertama, `+N more` |
| `edit_file` | `Edit src/App.tsx` | **DiffView** + chip `+12 −3` |
| `run_command` | `$ npm test` | **TerminalView** + chip exit code |
| `update_features` | `Update 6 features` | daftar sebelum/sesudah + **`Buka Plan →`** |
| `set_task_status` | `TASK-04 → done` | + **`Buka Board →`** |
| `generate_prd` | `Generate PRD` | ringkasan 7 poin + **`Buka PRD →`** |
| `mcp__<srv>__<tool>` | nama tool + badge server | JsonView |

**DiffView adalah pewarna unified-diff, bukan algoritma diff** — split `\n`, klasifikasi dari karakter awal, tanpa package `diff`. Kartu auto-expand saat `running`, auto-collapse saat `ok`, tetap terbuka saat `error`.

Markdown assistant di balik `React.lazy`, fallback `<pre className="whitespace-pre-wrap">` — persis rendering hari ini, jadi teks streaming polos dulu lalu naik kelas.

### Connection switcher

**Popover, bukan modal** — baris atas empat chip role (`Agent · Plan · PRD · Tasks`), badan daftar koneksi ter-expand jadi model dengan filter ketik. Klik model → terikat ke role terpilih → tutup. **Ganti model dua klik, tanpa modal.**

Preset saat `+ Add`:

| Preset | format | baseUrl |
|---|---|---|
| Local router (Anthropic) | `anthropic` | `http://localhost:20128/v1` |
| Ollama | `openai` | `http://localhost:11434/v1` |
| LM Studio | `openai` | `http://localhost:1234/v1` |
| OpenRouter | `openai` | `https://openrouter.ai/api/v1` |
| Anthropic | `anthropic` | `https://api.anthropic.com` |
| Gemini (OpenAI-compat) | `openai` | `https://generativelanguage.googleapis.com/v1beta/openai` |

Memilih preset langsung mem-probe `/models`. **Untuk tiga preset lokal ini benar-benar dua klik: pilih preset → Save.** Probe gagal bukan jalan buntu — field model jadi teks bebas dengan daftar chip, error asli ditampilkan inline, koneksi tetap bisa disimpan.

**Koneksi hidup di SQLite server, bukan localStorage.** Klien hanya CRUD lewat `/api/connections`. Ini menyelesaikan konflik antara dua rancangan: harness harus bisa bertindak tanpa tab terbuka.

**Migrasi sekali jalan:** saat boot, kalau tabel `connections` kosong dan request pertama membawa `llmConfig` lama, sintesis satu koneksi dari situ dan ikat keempat role. Pengguna lama membuka app dan setelannya sudah ada.

### Jembatan ke eksekusi task

`Step3AgentTasks` dapat prop `onRunTask?: (task) => void`; handler menyemai composer lalu mengirim, dan kartu bergerak sendiri saat agent memanggil `set_task_status`. Inilah interaksi yang menjadi alasan seluruh restrukturisasi ini — rinciannya di Bagian I.3.

---

## Bagian H — Diet

Baseline terukur: `index-*.js` = **1.298.022 B mentah / 353.988 B gzip**. `cynefin` (690 kB), `cytoscape` (443 kB), `katex` (261 kB) **sudah** chunk terpisah yang di-`import()` mermaid saat render — bukan masalahnya. Masalahnya **mermaid core** yang ditarik statis oleh `MermaidViewer.tsx:2`.

| # | Perubahan | Keluar dari chunk awal (mentah/gzip) |
|---|---|---|
| 1 | `MermaidViewer` → `React.lazy` | ≈ −465 kB / −135 kB |
| 2 | `PlanCanvas` (`@xyflow/react`) → `React.lazy` | ≈ −165 kB / −50 kB |
| 3 | Markdown → `React.lazy` bersama | ≈ −120 kB / −40 kB |
| 4 | `canvas-confetti` → dynamic import di handler | ≈ −7 kB |
| 5 | Split rute Step1/2/3 | ≈ −90 kB / −22 kB |
| 6 | Split `ExportModal` + `ConnectionsModal` | ≈ −25 kB / −7 kB |
| 7 | Buang `motion` dari `package.json` — **nol import di `src/`** | 0 kB bundle, −708 kB `node_modules` |

**Proyeksi: 1.298 kB → ≈ 440–480 kB mentah; 354 kB → ≈ 100–115 kB gzip.** Sekitar 3× lebih ringan, **tanpa satu fitur pun dihapus**. Verifikasi angkanya sekali dengan `rollup-plugin-visualizer` sebelum dipercaya.

`@xyflow/react` **dipertahankan (lazy), tidak ditulis tangan** — perubahan #2 sudah mendapat manfaat bundle-nya dengan satu baris; menulis ulang ~130 baris plus wheel/pinch/keyboard/`prefers-reduced-motion` demi 50 kB gzip yang sudah ditunda tidak sepadan di lintasan ini.

### Konsekuensi `@container` yang harus ditangani

`container-type: inline-size` membuat elemen jadi containing block untuk `position: fixed` di dalamnya:

| Elemen | Efek | Tindakan |
|---|---|---|
| `GenerationDialog` (`fixed inset-0`) | — | **Masalahnya lenyap**: fase 9 menghapus modal ini dan menggantinya dengan strip inline (I.2) |
| Modal detail task Step3 | ter-scope ke pane | **Masalahnya lenyap**: fase 10 menggantinya dengan panel geser (I.3) |
| `MermaidViewer` fullscreen (`:112`) | terpotong pane — tombol "Full screen" jadi bohong | **Perbaiki:** `createPortal(…, document.body)`, ~6 baris |

Substitusi breakpoint: hanya **10 utility** di tiga file step (`xl:` → `@5xl/pane:`, `md:grid-cols-3` → `@4xl/pane:` untuk kanban karena tiga kolom butuh ~290px masing-masing). Total kerusakan pada tiga file besar: **~35 baris dari 2.378 baris.**

---

## Bagian I — Perubahan UX yang diperlukan

Tiga hal ini tadinya saya tahan demi diff kecil. Dengan izin mengubah UI/UX, ketiganya masuk — bukan karena bisa, tapi karena tanpanya aplikasi tetap terasa wizard yang kebetulan punya panel chat.

### I.1 Intake jadi percakapan, bukan layar form

Hari ini memulai proyek berarti mengisi form (`Step1Plan` sub-view `form`), lalu menjawab pertanyaan klarifikasi di layar kedua (`clarify`), baru plan muncul (`plan_review`). Di harness, bertanya adalah pekerjaan chat.

Alur baru: pengguna mengetik idenya di composer → agent memanggil `ask_followups` → **pertanyaan muncul sebagai kartu interaktif di dalam transcript** (opsi, saran jawaban, nomor ronde — persis data yang sudah dihasilkan `/api/followup-questions` hari ini) → pengguna menjawab di kartu → jawaban pulang sebagai `tool_result` → agent memanggil `generate_plan` → **pane Plan terisi sementara pengguna menontonnya.**

Mesin klarifikasi bertingkat yang sudah ada dipakai utuh; yang berubah hanya tempat renderingnya. Itu sebabnya kanal elicitation di Bagian C ada.

**`Step1Plan.tsx` (1070 baris) dipecah tiga:**

| File | Isi | Asal |
|---|---|---|
| `src/components/plan/PlanView.tsx` | sub-view `plan_review`: summary, FeatureEditor, tech stack, arsitektur, Mermaid, roadmap, estimasi, PlanCanvas, banner stale + tombol re-sync | ~600 baris |
| `src/components/plan/PlanIntake.tsx` | sub-view `form` + `clarify`, **tetap ada** di balik tautan "Isi manual" | ~380 baris |
| `src/components/plan/followups.ts` | penggabungan ronde, pra-isi jawaban, state pertanyaan — dipakai PlanIntake **dan** kartu transcript | ~90 baris |

Jalur form tidak dibuang. Sebagian orang memang ingin mengisi kolom, dan membuangnya adalah menghapus fitur — yang tidak diminta.

**Satu kerapuhan ikut diperbaiki di sini karena ongkosnya jadi nol:** `Step1Plan.tsx:168-176` meng-key jawaban dengan **teks pertanyaan**, bukan `q.id` (yang sudah ada di `types.ts:22`), jadi pertanyaan yang diubah kata-katanya membuat jawabannya yatim. Karena `followups.ts` memang ditulis ulang, key pindah ke `id` dengan pembacaan mundur dari teks untuk sesi lama. Sebelumnya saya daftarkan sebagai "sengaja tidak ditangani".

### I.2 Modal generate yang memblokir → progres jujur di dalam pane

`GenerationDialog` menutupi seluruh layar dan `GenerationProgress.tsx:41` menampilkan **persentase yang dikarang**:

```ts
Math.min(95, Math.round((1 - Math.exp(-elapsed / (expectedMs / 2.5))) * 100))
```

Dua masalah sekaligus: angkanya bohong, dan modalnya mengunci agent pane persis saat pengguna mungkin ingin bertanya sesuatu.

Karena provider layer baru **sudah streaming**, sinyal nyata tersedia. Route generate ikut streaming dan mengirim `{type:"progress", chars}`; pane menampilkan strip inline (bukan modal): nama tahap, jumlah karakter yang sudah masuk, waktu berjalan, tombol Batal. Tanpa persentase — tidak ada yang tahu panjang akhirnya, dan menebak adalah yang dilakukan versi lama.

`GenerationDialog.tsx` (51 baris) dan kurva di `GenerationProgress.tsx` dihapus; `GenerationProgress` menyusut jadi strip ~35 baris. Konsekuensi menyenangkan: masalah `container-type` pada `GenerationDialog` di Bagian H hilang dengan sendirinya, karena tidak ada lagi `fixed inset-0` di sana.

### I.3 Papan yang bisa dikerjakan, bukan sekadar dilihat

Kanban tiga kolom di pane 58% memberi tiap kolom ~290px — muat, tapi kartunya (`Step3AgentTasks.tsx`) dirancang untuk halaman penuh. Perubahan:

- Kartu dipadatkan: judul, chip fase, chip prioritas, jumlah target file. Detail pindah ke panel geser, bukan modal `fixed`.
- Tombol **Run** per kartu (`onRunTask`) — menyemai composer dengan `promptInstructions` + `targetFiles` + id, lalu mengirim. Agent memanggil `set_task_status`, server menulis SQLite, `onToolApplied` refetch, **kartu bergerak sendiri di papan yang sedang dilihat.**
- Indikator "sedang dikerjakan agent" pada kartu yang id-nya muncul di giliran berjalan.
- Drag-and-drop HTML5 yang ada dipertahankan apa adanya, termasuk fallback tombol untuk sentuh/keyboard.

### Yang TIDAK diubah meski izinnya ada

`Step2PRD` hanya dapat substitusi breakpoint dan lazy-load. Helper koersi formatnya (`formatRequirementsToString`, `keepOrReplace`, label `[Functional]`/`Table:` yang sengaja di luar i18n — komentar `Step2PRD.tsx:34-38`) adalah hasil kerja keras yang menjaga data terstruktur tidak runtuh jadi teks datar saat bahasa diganti. Menyentuhnya berisiko tinggi dengan imbalan nol.

Tidak ada perombakan visual menyeluruh: token warna, tipografi, dan `index.css` yang ada dipakai apa adanya. Yang berubah adalah **struktur dan alur**, bukan selera.

---

## Fix sambil lewat

**Kebocoran API key di Full backup** (`ExportModal.tsx:80-83`) — `JSON.stringify(session)` menyertakan `session.llmConfig` dengan `apiKey` hidup **bahkan saat `saveApiKey` false**, karena key tetap ada di state sesi. File itu lalu masuk folder Downloads, dilampirkan ke issue, ter-commit. `sessionStore.ts:6-9` sudah punya helper yang tepat — cukup di-`export` dan dipakai ulang.

**Tiga generator AGENTS.md** → satu `src/lib/agentsMd.ts`, disemai dari versi terkaya (`Step3AgentTasks.tsx:107-131`). Yang di `server.ts:970-990` **mati** (`generate.ts:63` hanya membaca `data.tasks`) — hapus.

---

## Urutan fase — tiap fase meninggalkan app dalam keadaan jalan

| Fase | Isi | Verifikasi |
|---|---|---|
| **0** | Diet (H#1–4, 7) + pindahan `server/messages.ts`, `server/llm/json.ts` verbatim. Nol perubahan UI. **Perbaiki `--watch-path` di script `dev`** — kalau tidak, hot reload diam-diam berhenti untuk file baru. | `npm run lint`, generate plan end-to-end, ukur bundle |
| **1** | Provider layer + adapter. `callLlm` mendelegasi. Buang `@google/genai`. `agent.ts` belum disentuh. | 4 route generate terhadap Gemini, Ollama, dan satu router OpenAI-compat |
| **2** | Tabel koneksi + role, route, tiga probe. `llmConfig` masih menang bila ada → klien belum berubah. | Buat koneksi, discover model, tiga probe lulus |
| **3** | Agent loop di atas provider layer, tabel percakapan, abort + heartbeat, **hapus `agent.ts`, buang `@anthropic-ai/sdk`**. ChatPanel lama tetap hidup lewat jembatan legacy. | Chat terhadap router Anthropic DAN endpoint OpenAI; **ganti koneksi di tengah percakapan**; tutup tab saat `run_command` → child mati |
| **4** | Pipeline jadi tool (Bagian D) + tool coding (Bagian E). Aditif. | `edit_file` dengan `oldText` tidak unik ditolak dengan hitungan dan file **byte-identik**; agent membaca PRD lalu menjalankan satu task dari papan |
| **5** | Shell UI: Workbench, Splitter, PipelinePane, substitusi `@container`, portal Mermaid. ChatPanel di-host **tanpa diubah**. | Split pane di 1280px dan 900px; fullscreen diagram menutupi layar |
| **6** | Transcript: `useAgentRun`, ToolCallCard, renderer, DiffView, TerminalView, kartu elicitation. **Hapus `ChatPanel.tsx`.** | Dua tool paralel → hasil mendarat di kartu yang benar; tutup pane → transcript selamat |
| **7** | Connections UI + switcher + preset + tab MCP. **Hapus `LLMConfigModal.tsx`.** | Preset Ollama: dua klik sampai tersambung |
| **8** | **UX I.1** — pecah `Step1Plan` jadi `PlanView`/`PlanIntake`/`followups.ts`, intake percakapan lewat `ask_followups`, key jawaban pindah ke `id`. | Idea → pertanyaan di transcript → jawab → plan terisi di pane, tanpa pernah membuka form; sesi lama yang jawabannya ter-key teks tetap terbaca |
| **9** | **UX I.2** — route generate ikut streaming, strip progres inline, **hapus `GenerationDialog.tsx` dan kurva palsu**. | Generate PRD sambil mengetik di agent pane; Batal benar-benar membatalkan |
| **10** | **UX I.3** — kartu papan dipadatkan, panel geser detail, tombol Run, indikator sedang-dikerjakan. | Klik Run pada satu kartu → agent mengeksekusi → kartu pindah kolom sendiri |
| **11** | MCP client (Bagian F) + fix sambil lewat + sapuan i18n. | Satu server stdio + satu HTTP; bunuh stdio di tengah percakapan → giliran tetap selesai |

Fase 5–7 bisa paralel dengan 4 setelah 3 mendarat. Fase 8 butuh 4 (tool pipeline) dan 6 (kartu elicitation) sudah ada. Fase 9–10 hanya butuh 5.

---

## File kritis

- `agent.ts` — loop, spec tool, `resolveInsideRoot`, system prompt Indonesia. Diport lalu dihapus (fase 3).
- `server.ts` — `callLlm`, `parseJsonFromLlm`, `looksTruncated`, `openAiChatUrl`, `MESSAGES`, 4 route generate + prompt Indonesianya, transport SSE, approval. Turun ~1018 → ~700 baris.
- `db.ts` — butuh `export const db`; semua tabel baru menempel di sini.
- `src/components/ChatPanel.tsx` — bug pembuangan `provider` (`:99-103`) dan kontrak SSE/approval yang harus terus dihormati server.
- `src/App.tsx` — `useState` tunggal yang memegang seluruh domain; blok `main` diganti `<Workbench/>`.
- `src/components/Step1Plan.tsx` — 1070 baris, dipecah tiga (fase 8).
- `src/components/Step3AgentTasks.tsx` — 635 baris, kartu + panel detail dirombak (fase 10).
- `src/components/Step2PRD.tsx` — 673 baris, hanya token breakpoint + lazy-load; helper koersi format tidak disentuh.
- `package.json` — pembuangan dependency dan **perbaikan `--watch-path`**.

---

## Butuh review Anda

1. **API key plaintext di `data/undagi.db`.** Satu-satunya keputusan dengan tradeoff keamanan nyata: file itu gitignored, tapi backup atau folder tersinkron membocorkannya. Alasan memilihnya: server harus bisa memanggil model tanpa tab browser. Kolom `api_key_env` adalah jalan keluarnya. **Konfirmasi sebelum fase 2 mendarat.**
2. **`edit_file`/`write_file` tidak butuh approval**, sementara fase 4 menaikkan daya edit agent secara signifikan. Apakah penulisan file harus lewat kanal approval seperti `run_command`? Keputusan produk, sengaja tidak dirancang di sini.
3. **`run_command` tetap tanpa denylist** dan string perintahnya tidak di-sandbox (`agent.ts` mendokumentasikan ini sebagai disengaja). Fase 3 mempertahankan apa adanya — konfirmasi masih diinginkan sekarang setelah server MCP juga bisa men-spawn proses.
4. **Gemini pindah ke endpoint OpenAI-compat** mengubah format wire provider default. Uji manual end-to-end dengan key asli sebelum fase 1 di-merge.
5. **Agent di kiri atau kanan.** Satu `flex-row-reverse` ke arah mana pun.
6. **Jalur form manual tetap dipertahankan** (I.1). Kalau menurut Anda intake percakapan sudah cukup dan form itu beban rawat, `PlanIntake.tsx` bisa dihapus — tapi itu menghapus fitur, jadi keputusan Anda.

## Sengaja tidak ditangani

Azure OpenAI (butuh `?api-version=` dan bentuk path deployment yang tidak bisa disimpulkan normalizer) · OpenAI Responses API dan Gemini native (interface adapter membuat masing-masing jadi satu file baru — itulah tujuannya) · prompt caching, akuntansi biaya/token · streaming argumen tool parsial ke UI · branching dan penyuntingan percakapan · retry-backoff pada 429/5xx · MCP sampling/roots/resources · auth multi-user · perombakan visual/design-token (struktur dan alur yang berubah, bukan selera) · suite test (belum ada sama sekali; `npm run lint` hanya `tsc --noEmit`) — kalau ada satu tempat yang layak dapat test pertama, itu `server/llm/adapters/*` dan `edit_file`, karena keduanya punya input/output murni dan gagalnya senyap.
