# Tugas: Fase 2 — koneksi bernama & routing model

> Konteks besarnya ada di [`PLAN.md`](PLAN.md); aturan yang berlaku untuk semua fase
> ada di [`README.md`](README.md). Baca keduanya sebelum mulai.

**Prasyarat:** Fase 1 sudah mendarat — `server/llm/{types,url,sse,call,stream,models,legacy}.ts`
dan `server/llm/adapters/*` sudah ada, `callLlm` di `server.ts` sudah mendelegasi.

**Butuh konfirmasi pemilik repo sebelum dikerjakan:** fase ini menyimpan API key
plaintext di `data/undagi.db`. Kalau belum ada konfirmasi, berhenti dan tanya.

## Masalah yang diselesaikan

Hari ini konfigurasi model adalah satu objek `LLMConfig` di localStorage yang artinya
berbeda tergantung endpoint mana yang membacanya, dan `provider`-nya dibuang begitu
masuk ke jalur agent. Ganti model berarti menyunting satu-satunya konfigurasi yang ada.
Fase ini memberi beberapa koneksi bernama yang hidup di server, plus pengikatan
per-peran, sehingga agent bisa jalan di model kuat sementara generasi PRD di model murah.

Sekalian menutup satu cacat diam: `POST /api/test-llm` hanya menguji jalur JSON
non-streaming, jadi ia **lulus untuk endpoint yang agent-nya tidak akan bisa dipakai**.

## File yang dibuat

```
server/connections/store.ts     tabel connections + role_bindings, CRUD
server/connections/test.ts      testConnection() tiga probe
server/connections/routes.ts    express.Router()
```

## Perubahan di `db.ts`

Tambahkan satu baris: `export const db;` (instance `DatabaseSync` yang sudah ada).
Jangan ubah apa pun yang lain. Tiap modul store menjalankan `CREATE TABLE IF NOT EXISTS`
sendiri, jadi tidak ada berkas migrasi dan tidak ada urutan boot yang harus dijaga.

## Skema

```sql
CREATE TABLE IF NOT EXISTS connections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  format      TEXT NOT NULL,                  -- 'anthropic' | 'openai'
  base_url    TEXT NOT NULL,
  api_key     TEXT NOT NULL DEFAULT '',
  api_key_env TEXT NOT NULL DEFAULT '',       -- kalau diisi, process.env[...] menang atas api_key
  headers     TEXT NOT NULL DEFAULT '{}',
  models      TEXT NOT NULL DEFAULT '[]',     -- cache hasil discovery + entri manual
  json_mode   INTEGER NOT NULL DEFAULT 1,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_bindings (
  role          TEXT PRIMARY KEY,             -- 'agent' | 'plan' | 'prd' | 'tasks'
  connection_id TEXT NOT NULL,
  model         TEXT NOT NULL
);
```

`role_bindings` dibuat sebagai tabel empat baris, bukan kolom di `connections`, karena
peran menunjuk ke koneksi dan bukan sebaliknya — satu koneksi bisa melayani empat peran.

### Kenapa key ada di DB

Server harus bisa memanggil model tanpa tab browser terbuka; harness yang lumpuh saat
tab ditutup bukan harness. Kolom `api_key_env` adalah jalan keluar bagi yang menolak:
kalau diisi, nilainya dibaca dari `process.env[api_key_env]` dan `api_key` diabaikan.

**Key tidak pernah keluar dari server.** `GET /api/connections` mengembalikan
`hasKey: boolean`, tidak pernah nilainya. Pada penulisan: `apiKey: null` berarti
*pertahankan yang lama*, `apiKey: ""` berarti *hapus*. Bedanya penting — tanpa itu,
menyimpan perubahan nama koneksi akan menghapus key-nya.

## `server/connections/store.ts`

```ts
export interface StoredConnection extends Connection { apiKeyEnv: string; enabled: boolean; createdAt: string }
export type Role = "agent" | "plan" | "prd" | "tasks";

export function listConnections(): StoredConnection[];
export function getConnection(id: string): StoredConnection | null;   // apiKey sudah diresolve dari env bila perlu
export function upsertConnection(input: Partial<StoredConnection> & { id?: string }): StoredConnection;
export function deleteConnection(id: string): void;
export function listRoles(): Partial<Record<Role, { connectionId: string; model: string }>>;
export function setRole(role: Role, connectionId: string, model: string): void;
export function resolveRole(role: Role): { conn: Connection; model: string } | null;
```

`resolveRole` mengembalikan `null`, bukan melempar — pemanggilnya yang memutuskan
apakah ketiadaan binding itu fatal.

## Urutan resolusi (dipakai semua route)

```
1. body.connectionId + body.model
2. body.llmConfig            -> legacyToConnection(), ephemeral, tidak disimpan
3. role_bindings[role]
4. kalau hanya ada satu koneksi enabled: pakai itu dengan models[0]
5. error yang menyebut persis apa yang kurang
```

**Urutan 2 sebelum 3 disengaja untuk fase ini**: klien lama masih mengirim `llmConfig`
di setiap request generate, dan selama fase 2 belum ada UI koneksi, `llmConfig` harus
tetap menang supaya tidak ada regresi. Fase 7 yang membalik prioritasnya setelah UI ada.

Tulis satu helper dan pakai di lima titik, jangan disalin:

```ts
export function resolveFor(role: Role, body: any, lang: Lang): { conn: Connection; model: string };
```

## `server/connections/test.ts` — tiga probe

```ts
export interface Probe { name: "models" | "chat" | "tools"; ok: boolean; ms: number; detail?: string }

export async function testConnection(conn: Connection, model: string, lang: Lang): Promise<{
  ok: boolean; toolsSupported: boolean; models: string[]; probes: Probe[];
}>;
```

1. **`models`** — panggil `listModels`. Informasional saja: endpoint tanpa `/models`
   itu normal, kegagalannya **tidak** menggagalkan test.
2. **`chat`** — satu giliran **streaming** sungguhan lewat `streamLlm`, `maxTokens: 64`,
   prompt `Reply with the single word: ok`. Lulus kalau ada minimal satu event `text`
   **dan** satu event `done`. Inilah probe yang benar-benar menguji parsing SSE dan
   normalisasi base URL — dua hal yang paling sering patah. **Gagal di sini = fatal.**
3. **`tools`** — giliran streaming yang sama, ditambah satu tool sepele:
   `{ name: "ping", description: "Reply by calling this tool.", parameters: { type: "object", properties: {}, required: [] } }`
   dengan prompt yang memaksa pemanggilan. Lulus kalau ada event `tool_call` dengan
   input yang ter-parse. Gagal → kembalikan `ok: true, toolsSupported: false`, bukan
   gagal total: koneksi yang hanya diikat ke `plan`/`prd`/`tasks` memang tidak butuh tool.

Probe 3 adalah yang memisahkan "endpoint menjawab" dari "endpoint bisa menjalankan
agent". Hari ini tidak ada yang mengeceknya sama sekali.

Beri tiap probe timeout sendiri (30 detik cukup) supaya endpoint yang menggantung tidak
menahan seluruh test sampai batas 300 detik.

## Route (`server/connections/routes.ts`, di-mount di `server.ts`)

| Method | Path | Isi |
|---|---|---|
| GET | `/api/connections` | `{ connections: [...tanpa apiKey, + hasKey], roles }` |
| POST | `/api/connections` | buat, balas koneksi tanpa key |
| PUT | `/api/connections/:id` | update; `apiKey: null` = pertahankan, `""` = hapus |
| DELETE | `/api/connections/:id` | hapus; role yang menunjuk ke sana ikut dibersihkan |
| POST | `/api/connections/:id/models` | refresh discovery, simpan hasilnya, balas `{models, source, error?}` |
| POST | `/api/connections/:id/test` | tiga probe atas koneksi tersimpan |
| POST | `/api/connections/test` | tiga probe atas draft yang belum disimpan (body memuat koneksinya) |
| PUT | `/api/roles` | `{ role, connectionId, model }` |

`POST /api/test-llm` **tetap ada** sebagai alias tipis yang memanggil `testConnection`
lewat `legacyToConnection(body.llmConfig)`, supaya `LLMConfigModal` yang sekarang tidak
mati sebelum fase 7 menggantinya. Bentuk responsnya harus tetap `{success, response}` /
`{success:false, error}` seperti sekarang — modal lama membaca bentuk itu.

## Yang TIDAK boleh disentuh

- `agent.ts` — fase 3.
- Semua prompt Bahasa Indonesia di `server.ts`, `parseJsonFromLlm`, `looksTruncated`.
- Post-processing tiap route generate.
- Apa pun di `src/`. Fase ini murni server.
- Tabel `sessions` — tanpa migrasi, tanpa kolom baru.

## Selesai kalau

1. `npm run lint` dan `npm run build` bersih.
2. Membuat koneksi lewat `POST /api/connections`, lalu `POST /:id/models`, lalu
   `POST /:id/test` — ketiga probe melaporkan hasilnya, dan probe `models` yang gagal
   tidak menggagalkan keseluruhan.
3. `GET /api/connections` **tidak pernah** memuat nilai API key. Buktikan dengan
   `curl … | grep -i "sk-\|apiKey"` yang kosong.
4. Menyimpan ulang koneksi tanpa mengirim `apiKey` **tidak** menghapus key-nya.
5. Empat route generate masih bekerja persis seperti sebelumnya dengan `llmConfig`
   yang dikirim klien lama — tidak ada perubahan di `src/`.
6. `git diff --stat` tidak menyentuh `agent.ts` maupun `src/`.

## Berhenti dan lapor kalau

- Belum ada konfirmasi soal penyimpanan key plaintext.
- Fase 1 ternyata belum mendarat atau bentuk `Connection`/`streamLlm` berbeda dari
  yang diasumsikan brief ini.
