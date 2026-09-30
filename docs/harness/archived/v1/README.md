# Arsip v1 — fase 01–11

> Arsip historis. Jangan gunakan sebagai konteks pekerjaan v2 kecuali diminta.

# Rombak jadi agent harness agnostik — papan kerja

Folder ini berisi rencana perombakan dan brief per fase. Brief ditulis supaya bisa
diserahkan apa adanya ke agent coding (Codex desktop) tanpa konteks percakapan.

- [`PLAN.md`](PLAN.md) — rencana lengkap: arsitektur sasaran, keputusan kunci beserta
  alasannya, urutan fase, apa yang butuh review manusia, dan apa yang sengaja tidak
  ditangani. **Baca ini dulu sebelum mengerjakan brief mana pun.**
- `fase-NN-*.md` — brief satu fase, siap dikerjakan.

## Aturan yang berlaku untuk semua fase

1. **Satu fase per sesi.** Tiap fase dirancang untuk meninggalkan aplikasi dalam
   keadaan jalan. Mengerjakan dua sekaligus menghilangkan sifat itu.
2. **Berhenti dan lapor kalau ada yang bertentangan** dengan brief, jangan menebak.
   Tebakan yang terdengar yakin lebih mahal daripada pertanyaan.
3. **Diff bedah.** Jangan memformat ulang, mengganti nama, atau merapikan kode di
   sebelah yang tidak diminta — itu mengubur perubahan sebenarnya dan menyulitkan
   rollback.
4. **Komentar dalam Bahasa Indonesia** dan menjelaskan *kenapa*, bukan *apa*. Ikuti
   gaya `server.ts` dan `agent.ts` yang sudah ada.
5. **Prompt Bahasa Indonesia di `server.ts` tidak boleh berubah satu karakter pun.**
   Begitu juga `parseJsonFromLlm` dan `looksTruncated` di `server/llm/json.ts` —
   keduanya hasil kerja keras menghadapi model yang JSON-nya berantakan.
6. **Verifikasi sebelum lapor selesai:** `npm run lint` (yaitu `tsc --noEmit`) dan
   `npm run build` harus bersih. Kode tanpa verifikasi adalah klaim, bukan hasil.

## Status

| Fase | Isi | Status | Brief |
|---|---|---|---|
| 0 | Diet bundel + ekstraksi `server/messages.ts` dan `server/llm/json.ts` | **Selesai** | — |
| 1 | Provider layer + adapter Anthropic/OpenAI, `callLlm` mendelegasi, buang `@google/genai` | **Selesai** | [`fase-01-provider-layer.md`](fase-01-provider-layer.md) |
| 2 | Tabel koneksi + role binding, route, tiga probe test koneksi | **Selesai** | [`fase-02-koneksi-dan-role.md`](fase-02-koneksi-dan-role.md) |
| 3 | Agent loop provider-netral, tabel percakapan, abort, hapus `agent.ts` | **Selesai** | [`fase-03-agent-loop-netral.md`](fase-03-agent-loop-netral.md) |
| 4 | Pipeline PRD jadi tool agent + tool coding (`glob`, `grep`, `edit_file`) | **Selesai** | [`fase-04-tool-pipeline-dan-coding.md`](fase-04-tool-pipeline-dan-coding.md) |
| 5 | Shell UI: Workbench, splitter, pipeline pane | **Selesai** | [`fase-05-shell-ui.md`](fase-05-shell-ui.md) |
| 6 | Transcript: tool card, diff view, terminal view | **Selesai** | [`fase-06-transcript.md`](fase-06-transcript.md) |
| 7 | UI koneksi + switcher model + preset | **Selesai** | [`fase-07-ui-koneksi.md`](fase-07-ui-koneksi.md) |
| 8 | UX: intake percakapan, pecah `Step1Plan` | **Selesai** | [`fase-08-intake-percakapan.md`](fase-08-intake-percakapan.md) |
| 9 | UX: progres generate inline, hapus modal + kurva palsu | **Selesai** | [`fase-09-progres-generate.md`](fase-09-progres-generate.md) |
| 10 | UX: papan task yang bisa dieksekusi | **Selesai** | [`fase-10-papan-eksekusi.md`](fase-10-papan-eksekusi.md) |
| 11 | MCP client + penutup (i18n, README, .env.example) | **Selesai** | [`fase-11-mcp-dan-penutup.md`](fase-11-mcp-dan-penutup.md) |

### Ketergantungan antar fase

Fase 1 → 2 → 3 berurutan; itu tulang punggungnya. Sesudah fase 3 mendarat:

```
3 ──┬── 4 (tool pipeline + coding) ──┐
    └── 5 (shell) ──┬── 6 (transcript) ──┴── 8 (intake percakapan)
                    ├── 7 (UI koneksi, butuh 2 juga)
                    ├── 9 (progres generate)
                    └── 10 (papan, lebih baik setelah 4 dan 6)
11 butuh 3 dan 7.
```

Fase 4, 5, dan 9 bisa berjalan paralel. Brief ditulis sekaligus di muka atas permintaan
pemilik repo; konsekuensinya, **brief fase belakangan mengasumsikan bentuk akhir fase
sebelumnya**. Kalau sebuah fase mendarat dengan bentuk berbeda dari yang diasumsikan,
perbarui brief sesudahnya sebelum mengerjakannya — jangan memaksakan isinya.

## Apa yang sudah berubah di Fase 0

- `MermaidViewer`, `PlanCanvas`, dan react-markdown dimuat lewat `React.lazy` di
  [`src/components/lazy.tsx`](../../../src/components/lazy.tsx); `canvas-confetti` jadi
  dynamic import di handler-nya.
- Chunk awal turun dari **1.298 kB → 334 kB** mentah (**355,6 kB → 98,7 kB** gzip),
  tanpa satu fitur pun dihapus.
- `motion` dibuang dari `package.json` (nol import di `src/`), `@types/canvas-confetti`
  pindah ke `devDependencies`.
- `Lang`, `langOf`, `MESSAGES`, `LlmError`, `msg`, `describeFetchError` pindah utuh ke
  `server/messages.ts`; `looksTruncated`, `parseJsonFromLlm` pindah utuh ke
  `server/llm/json.ts`. `server.ts` turun 1018 → 884 baris.
- Script `dev` di `package.json` dapat `--watch-path=./server` — tanpa itu hot reload
  diam-diam berhenti untuk berkas baru di folder tersebut.

## Butuh keputusan Anda sebelum fase tertentu mendarat

Empat hal ini ada di bagian **Butuh review Anda** di `PLAN.md`; yang paling mendesak:

- **Fase 2:** API key disimpan plaintext di `data/undagi.db`. Alasannya server harus
  bisa memanggil model tanpa tab browser terbuka. Kolom `api_key_env` disediakan sebagai
  jalan keluar. Konfirmasi sebelum fase 2 dikerjakan.
- **Fase 4:** `edit_file`/`write_file` tidak lewat kanal approval, padahal fase itu
  menaikkan daya edit agent secara signifikan.
