# Tugas: Fase 11 — MCP client & penutup

> Konteks besarnya ada di [`PLAN.md`](PLAN.md); aturan yang berlaku untuk semua fase
> ada di [`README.md`](README.md). Baca keduanya sebelum mulai.

**Prasyarat:** Fase 3 (registry `ToolSpec`) dan fase 7 (tab MCP di UI koneksi) sudah
mendarat.

Fase ini aditif: dengan nol server terkonfigurasi, tidak ada perilaku yang berubah.

## Masalah yang diselesaikan

Tool harness hari ini hanya yang ditulis di dalam repo ini. MCP membuat kemampuan agent
bisa ditambah tanpa menyentuh kode — dan itulah arti "agnostik" di sisi tool, sebagaimana
lapis adapter adalah artinya di sisi model.

## Keputusan: ditulis tangan, tanpa SDK

Subset yang dibutuhkan — `initialize`, `tools/list`, `tools/call` di atas stdio dan
streamable-HTTP — sekitar 250 baris. `@modelcontextprotocol/sdk` menarik zod dan
kawan-kawannya, melawan diet yang jadi salah satu tujuan perombakan ini.

**Escape hatch, tulis sebagai komentar:** kalau perubahan protokol nanti menyulitkan,
tukar `server/mcp/client.ts` dengan SDK resmi di balik interface `McpClient` yang sama.

## File

```
server/mcp/jsonrpc.ts     framing + korelasi id
server/mcp/stdio.ts       transport stdio
server/mcp/http.ts        transport streamable HTTP
server/mcp/client.ts      McpClient
server/mcp/registry.ts    pool, lazy connect, reaper idle, namespacing
server/mcp/store.ts       tabel mcp_servers
server/mcp/routes.ts      CRUD + test
```

```ts
export interface McpClient {
  listTools(): Promise<{ name: string; description: string; inputSchema: Record<string, unknown> }[]>;
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
  readonly state: "ready" | "connecting" | "down" | "crashed";
  readonly lastError?: string;
}
```

## Protokol

`initialize` (protocolVersion `2025-06-18`, `capabilities: {}`, `clientInfo: {name:"undagi"}`)
→ `notifications/initialized` → `tools/list` (ikuti `nextCursor` sampai habis) → `tools/call`.

Notifikasi masuk `notifications/tools/list_changed` menandai cache basi. Notifikasi lain
diabaikan.

### stdio

`spawn(command, args, { env: {...process.env, ...env}, cwd, stdio: ["pipe","pipe","pipe"] })`.

**Framing-nya newline-delimited JSON, BUKAN `Content-Length` ala LSP.** Ini kesalahan
klasik saat mengimplementasikan MCP stdio; tulis satu baris komentar supaya tidak
"diperbaiki" jadi LSP oleh orang berikutnya.

stderr masuk ke log server **dan** ring buffer 50 baris yang bisa ditampilkan UI — tanpa
itu, server yang gagal start hanya terlihat sebagai "tidak ada tool".

### streamable HTTP

POST dengan `content-type: application/json` dan
`accept: application/json, text/event-stream`, plus header `Mcp-Session-Id` begitu server
memberikannya.

- Respons `application/json` → parse langsung.
- Respons `text/event-stream` → **pakai ulang `server/llm/sse.ts`** dari fase 1, baca frame
  sampai menemukan yang `data.id`-nya cocok.
- `202` dengan body kosong = notifikasi diterima.

**Tidak diimplementasi:** GET listening stream, resumability/`Last-Event-ID`, dan transport
lama 2024-11-05 HTTP+SSE.

## Skema

```sql
CREATE TABLE IF NOT EXISTS mcp_servers (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,                  -- juga jadi prefix nama tool
  transport TEXT NOT NULL,                  -- 'stdio' | 'http'
  command   TEXT NOT NULL DEFAULT '',
  args      TEXT NOT NULL DEFAULT '[]',
  env       TEXT NOT NULL DEFAULT '{}',
  url       TEXT NOT NULL DEFAULT '',
  headers   TEXT NOT NULL DEFAULT '{}',
  enabled   INTEGER NOT NULL DEFAULT 1
);
```

## Lifecycle (`server/mcp/registry.ts`)

`Map<string, McpClient>` tingkat modul.

**Connect malas pada giliran agent pertama yang membutuhkan tool**, lalu keep-alive
dengan reaper idle 10 menit (server stdio mahal untuk di-spawn ulang).

**Tidak pernah connect saat boot.** Startup aplikasi tidak boleh bergantung pada unduhan
`npx` — kalau jaringan lambat, aplikasi ikut lambat menyala tanpa alasan yang terlihat.

### Tabrakan nama

Namespace `mcp__<server>__<tool>`, disanitasi ke `[a-zA-Z0-9_-]`, dipotong 64 karakter
(OpenAI membatasi di situ; kedua API menegakkan pola nama). Tabrakan setelah sanitasi
dapat akhiran `_2`.

Tool bawaan selalu menang. Prefix membuat itu mustahil dilanggar secara struktural —
tapi tetap pasang assertion, karena "mustahil" adalah tempat bug bersembunyi.

Total tool dicap 100; kelebihannya membuang tool MCP dan mengirim event `mcp_status`
berisi peringatan.

### Saat server mati — ini bagian yang menentukan apakah harness terasa kokoh

1. `toolsFor()` memanggil `listTools()` ke semua server **paralel dengan budget 1500 ms
   per server**. Server lambat atau mati menyumbang nol tool giliran itu plus satu event
   `mcp_status`; **giliran tetap berjalan normal.**
2. Memanggil tool yang servernya sudah mati → `{ error: "Server MCP 'x' tidak bisa
   dihubungi: …" }`. Error jadi hasil, bukan throw, sehingga model memutar arah.
3. Server stdio yang keluar ditandai `crashed` beserta baris stderr terakhirnya, dan
   dicoba ulang sekali pada giliran berikutnya di balik backoff 30 detik — supaya perintah
   yang salah tidak di-spawn ulang setiap giliran.

**Sengaja tidak dibangun:** sampling, roots, elicitation, prompts, resources. `resources`
hampir gratis secara protokol (`resources/list` + `resources/read`) tapi tidak berguna
tanpa UI, jadi tetap di luar.

## Route

`GET|POST /api/mcp/servers`, `PUT|DELETE /api/mcp/servers/:id`, `POST /api/mcp/test`
(connect, `tools/list`, tutup, balas `{ok, tools, error?}`).

Tab MCP di `ConnectionsModal` dari fase 7 tinggal disambungkan.

## Penutup — sisa pekerjaan kecil

Kerjakan hanya yang belum mendarat di fase sebelumnya:

1. **Sapuan i18n.** Telusuri semua string Inggris baru dari fase 5–10 dan pastikan
   masing-masing punya entri di map `ID` di `src/lib/i18n.tsx`. String yang hilang jatuh
   ke Inggris, jadi tidak ada yang rusak — tapi antarmuka jadi campur aduk. Hapus juga
   entri yang sudah tidak dipakai siapa pun.
   **Jangan terjemahkan:** nama produk (`Ollama`, `LM Studio`, `OpenRouter`, `Anthropic`),
   nama tool (`write_file`, `run_command`), dan label struktural di `Step2PRD`
   (`[Functional]`, `Table:`) — yang terakhir ini akan merusak data, alasannya ada sebagai
   komentar di `Step2PRD.tsx:34-38`.
2. **Perbarui `README.md`** di akar repo. Bagian yang sekarang menjelaskan bahwa agent
   membutuhkan endpoint berformat Anthropic sudah tidak benar lagi setelah fase 3, begitu
   juga daftar environment variable dan bagian LLM settings.
3. **Perbarui `.env.example`** — `ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` bukan lagi
   jalur utama.
4. **Naikkan syarat Node di README** dari "22.5 atau lebih baru" jadi 22.14+ / 24
   disarankan: `fs.promises.glob` (fase 4) dan `AbortSignal.any` (fase 1) butuh itu.
5. **Perbarui `docs/harness/README.md`** — tandai semua fase selesai.

## Selesai kalau

1. `npm run lint` dan `npm run build` bersih.
2. Satu server stdio dan satu server HTTP terkonfigurasi, tool keduanya muncul di daftar
   tool agent dengan prefix yang benar.
3. **Bunuh proses server stdio di tengah percakapan** — giliran yang sedang berjalan tetap
   selesai, dan giliran berikutnya melaporkan server itu `crashed` tanpa mematikan chat.
4. Server HTTP yang URL-nya salah: aplikasi tetap menyala normal, tidak ada penundaan saat
   boot.
5. Dengan nol server MCP terkonfigurasi, tidak ada perilaku yang berbeda dari fase 10.
6. Tidak ada string antarmuka berbahasa Inggris yang muncul saat bahasa disetel Indonesia,
   di luar daftar pengecualian di atas.
7. `README.md` di akar repo tidak lagi memuat klaim yang sudah tidak benar.

## Berhenti dan lapor kalau

- Sebuah server MCP menuntut kapabilitas di luar subset (`sampling`, `roots`) untuk bisa
  `initialize` sama sekali — itu informasi yang mengubah ruang lingkup, laporkan.
