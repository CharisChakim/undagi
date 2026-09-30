# Tugas: Fase 5 — shell harness (Workbench, splitter, pipeline pane)

> Konteks besarnya ada di [`PLAN.md`](PLAN.md); aturan yang berlaku untuk semua fase
> ada di [`README.md`](README.md). Baca keduanya sebelum mulai.

**Prasyarat:** Fase 3 sudah mendarat (agent loop netral). Fase ini tidak bergantung pada
fase 4.

Fase ini **tidak menyentuh isi `ChatPanel.tsx`** — panel lama dipasang apa adanya di slot
barunya. Penggantiannya fase 6.

## Masalah yang diselesaikan

Aplikasi ini berbentuk wizard tiga halaman dengan panel chat yang menutupi sebagian layar
(`ChatPanel` memakai `fixed inset-y-0 right-0 … lg:static lg:w-96`). Di harness, chat
adalah permukaan utama dan hasil kerjanya harus terlihat di sebelahnya — pengguna ingin
menonton plan dan papan task berubah saat agent menyentuhnya.

## Layout sasaran

```
┌ Rail ─────┬─────────────── Workbench ──────────────────────────┐
│ ● Agent   │ Topbar: judul · [Agent|Split|Board] · ●conn·model ▾ │
│ 1 Plan  ✓ ├──────────────────────┬─────────────────────────────┤
│ 2 PRD   ✓ │ AgentPane            ║ PipelinePane                │
│ 3 Tasks 🔒│  transcript          ║  [Plan][PRD][Tasks]         │
│           │  composer            ║  @container/pane            │
└───────────┴──────────────────────╨─────────────────────────────┘
```

Agent di **kiri** (permukaan yang diketik), pipeline di **kanan** (yang dihasilkan).
Split bawaan 42/58 — pipeline dapat separuh lebih besar karena isinya lebih padat.
Kalau pemilik repo lebih suka sebaliknya, itu satu `flex-row-reverse`.

## File

**Baru:**

```
src/lib/layout.ts                       ~40 baris, localStorage
src/components/shell/Workbench.tsx      ~140 baris
src/components/shell/Splitter.tsx       ~40 baris
src/components/shell/PipelinePane.tsx   ~90 baris
```

**Diubah:** `src/App.tsx`, `src/components/Topbar.tsx`, `src/components/Sidebar.tsx`,
`src/lib/routing.ts`, `src/components/MermaidViewer.tsx`, dan **hanya token breakpoint**
di tiga berkas step.

### `src/lib/layout.ts`

Ikuti gaya `src/lib/theme.ts` dan `src/lib/localStorage.ts` yang sudah ada — try/catch
di sekeliling setiap akses, kembalikan bawaan saat gagal.

```ts
export type LayoutMode = "agent" | "split" | "board";
export const loadLayout: () => { mode: LayoutMode; ratio: number };  // ratio 0.25–0.75
export const saveLayout: (v: { mode: LayoutMode; ratio: number }) => void;
// key: "undagi_layout"
```

- `split` — bawaan di viewport > 1100px.
- `agent` — agent selebar penuh; pipeline menyusut jadi strip chip di bawah topbar
  (`Plan ✓ · PRD ✓ · Tasks 4/12`), tiap chip diklik masuk ke `split`.
- `board` — pipeline selebar penuh; agent menyusut jadi pill di kanan bawah
  (`Agent · 2 berjalan`) yang bisa dibuka lagi.
- Di bawah 1100px, `split` dipaksa ke `agent` atau `board` (mana yang terakhir aktif),
  dan kontrol segmented di topbar berpindah di antara keduanya.

### `src/components/shell/Splitter.tsx`

Tanpa library. `onPointerDown` → `setPointerCapture`; `onPointerMove` →
`ratio = clamp((e.clientX - rect.left) / rect.width, .25, .75)`; `onPointerUp` →
`saveLayout`. `role="separator"`, `aria-orientation="vertical"`, panah kiri/kanan
menggeser ±2%, `touch-action: none` pada handle-nya.

### Routing — tambahan enam baris, `STEP_PATHS` tidak berubah

`/plan`, `/prd`, `/tasks` tetap bekerja dan bookmark lama selamat. Yang berubah hanya
maknanya: URL sekarang berarti *tab mana yang sedang ditampilkan pipeline pane*, bukan
*halaman mana yang sedang dibuka* — karena di mode `split` pipeline selalu terlihat.

```ts
export const AGENT_PATH = "/";
```

`pathToStep("/")` sudah mengembalikan `null`, dan `App.tsx` sudah jatuh ke
`session.currentStep` dalam kasus itu — tidak ada perubahan yang dibutuhkan di sana.
Satu-satunya suntingan: di `useEffect` yang mem-push URL (`App.tsx:93-97`), push `/`
ketika `layout.mode === "agent"`, selain itu push `STEP_PATHS[currentStep]`.

**Gerbang reachability tetap ada.** `isStepReachable` dan cerminannya di `Sidebar.tsx`
tidak berubah — tab yang terkunci dirender terlihat-tapi-nonaktif dengan alasan yang
sudah ada.

### `App.tsx`

- Blok `<main>` (sekarang `App.tsx:274-311`, memuat banner `storeError` dan tiga
  `session.currentStep === N &&`) diganti satu `<Workbench … />`.
- State `isChatOpen` dihapus; blok `<ChatPanel …>` (`App.tsx:316-332`) dipindah ke dalam
  `AgentPane` milik Workbench, **isinya tidak diubah**.
- Handler `onToolApplied` yang me-refetch sesi ikut pindah jadi prop Workbench. Jangan
  diubah logikanya: tool chat menulis langsung ke SQLite, jadi salinan di memori memang
  harus dimuat ulang.
- Banner `storeError` pindah ke Workbench, di atas kedua pane.

Perkiraan: −55 / +18 baris.

### `PipelinePane.tsx`

```tsx
<div className="@container/pane flex-1 min-w-0 overflow-y-auto">
  <TabStrip … />                                    {/* sticky top-0 */}
  <div className="px-4 @3xl/pane:px-8 py-8">
    <Suspense fallback={<PaneSkeleton/>}>
      {step === 1 && <Step1Plan …/>}
      {step === 2 && <Step2PRD …/>}
      {step === 3 && <Step3AgentTasks …/>}
    </Suspense>
  </div>
</div>
```

Prop ketiga komponen step **tidak berubah**: `session`, `onUpdateSession`,
`onGoToNextStep`, `onSelectSample`.

Tiga step di-`React.lazy` supaya keadaan kosong/agent-only tidak memuat semuanya.

## Substitusi container query — persis sepuluh utility

Tailwind 4 punya container query di core. Breakpoint viewport tidak berguna di dalam pane:
pada layar 1440px dengan pane 800px, `xl:` tetap menyala dan kanban menjejalkan tiga kolom
ke 800px.

Ukuran container Tailwind: `@xl`=576, `@2xl`=672, `@3xl`=768, `@4xl`=896, `@5xl`=1024.

| Berkas:baris | Dari | Jadi |
|---|---|---|
| `Step1Plan.tsx:424` | `xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]` | `@5xl/pane:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]` |
| `Step1Plan.tsx:426` | `md:grid-cols-2` | `@2xl/pane:grid-cols-2` |
| `Step1Plan.tsx:567` | `xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]` | `@5xl/pane:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]` |
| `Step1Plan.tsx:899` | `xl:grid-cols-2` | `@4xl/pane:grid-cols-2` |
| `Step1Plan.tsx:963` | `md:grid-cols-2` | `@2xl/pane:grid-cols-2` |
| `Step1Plan.tsx:996` | `lg:grid-cols-3` | `@4xl/pane:grid-cols-3` |
| `Step1Plan.tsx:997` | `lg:col-span-2` | `@4xl/pane:col-span-2` |
| `Step2PRD.tsx:439` | `md:grid-cols-3` | `@3xl/pane:grid-cols-3` |
| `Step3AgentTasks.tsx:290` | `md:grid-cols-3` | `@4xl/pane:grid-cols-3` |
| `Step3AgentTasks.tsx:493` | `sm:grid-cols-2` | `@xl/pane:grid-cols-2` |

Kanban sengaja `@4xl` (896px), bukan 768px: tiga kolom butuh ~290px masing-masing.

Selain itu, `max-w-4xl`/`max-w-5xl`/`max-w-6xl` yang membungkus konten di dalam pane jadi
`max-w-none` — pane sendiri sudah jadi batasnya. `max-w-2xl`/`max-w-3xl`/`max-w-md`/
`max-w-xl` pada teks pengantar dan kartu kecil **dibiarkan** — itu batas panjang baris,
bukan batas layout.

Nomor baris di atas dari kondisi sebelum fase ini; verifikasi isinya cocok sebelum
menyunting, jangan percaya nomornya buta.

## Konsekuensi `container-type: inline-size` — WAJIB ditangani

`container-type: inline-size` membuat elemen jadi containing block untuk keturunan
`position: fixed`. Tiga tempat terdampak:

| Elemen | Efek | Tindakan di fase ini |
|---|---|---|
| `GenerationDialog` (`fixed inset-0`) | backdrop hanya menutupi pipeline pane | **Terima** — agent pane tetap bisa dipakai saat PRD digenerate, itu justru lebih baik. Fase 9 menghapus modal ini sepenuhnya. |
| Modal detail task di `Step3AgentTasks` | ter-scope ke pane | **Terima.** Fase 10 menggantinya dengan panel geser. |
| `MermaidViewer` fullscreen (`MermaidViewer.tsx:112`, `fixed inset-4 z-50`) | terpotong pane — tombol berlabel "Full screen" yang hanya menutupi 58% layar itu bohong | **Perbaiki sekarang:** bungkus cabang fullscreen dengan `createPortal(…, document.body)`, ~6 baris. |

`position: sticky` tidak terpengaruh containment, jadi tab strip dan `Sidebar` aman.

## Yang TIDAK boleh disentuh

- Isi `ChatPanel.tsx` — dipasang apa adanya, diganti di fase 6.
- Logika internal ketiga komponen step: sub-view state, helper koersi format di
  `Step2PRD` (`formatRequirementsToString`, `keepOrReplace`, label `[Functional]`/`Table:`
  yang sengaja di luar i18n), drag-and-drop di `Step3AgentTasks`. **Hanya token kelas.**
- `isStepReachable` dan gerbang sidebar.
- Apa pun di `server/`.

## i18n

Sekitar 8 string baru (label mode layout, judul tab strip, teks chip status). Tiap string
Inggris baru butuh entri di map `ID` di `src/lib/i18n.tsx`. String yang tidak ada di map
jatuh ke Inggris, bukan layar kosong — jadi aman, tapi tetap lengkapi.

## Selesai kalau

1. `npm run lint` dan `npm run build` bersih.
2. Di viewport 1400px: mode `split` menampilkan agent dan pipeline berdampingan, splitter
   bisa ditarik, rasionya bertahan setelah reload.
3. Di viewport 900px: `split` jatuh ke mode tunggal, tidak ada scroll horizontal pada body.
4. Ketiga tab pipeline (Plan/PRD/Tasks) dirender benar di dalam pane 58% — periksa bahwa
   kanban tidak menjejalkan tiga kolom ke lebar sempit.
5. Tombol "Full screen" di `MermaidViewer` benar-benar menutupi seluruh layar, bukan
   hanya pane-nya.
6. `/plan`, `/prd`, `/tasks` masih membuka tab yang benar; tombol back/forward browser
   masih bekerja.
7. Chat masih berfungsi persis seperti sebelumnya di slot barunya.

## Berhenti dan lapor kalau

- Substitusi container query menimbulkan layout yang jelas rusak di salah satu step —
  laporkan berkas dan barisnya, jangan menambal dengan utility baru yang tidak ada di
  tabel.
