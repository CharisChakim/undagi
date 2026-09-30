# Menghubungkan runtime dan endpoint

Dokumen ini menjelaskan cara Undagi menemukan runtime agent, apa yang
harus dipasang agar sebuah runtime terpakai, dan bagaimana membaca kegagalan
yang muncul di kartu runtime. Untuk kontrak discovery tingkat protokol —
antarmuka metadata apa yang dipanggil dan apa batas kapabilitasnya — lihat
[`runtime-compatibility.md`](runtime-compatibility.md).

Ada dua jenis koneksi, dan keduanya tidak saling menggantikan:

- **Runtime agent** (Codex, Claude Code, Antigravity). Dipasang sebagai CLI di
  mesin yang menjalankan backend, dan diautentikasi lewat CLI-nya sendiri.
  Aplikasi tidak pernah meminta API key untuk ketiganya.
- **Custom endpoint** (jalur "Legacy API"). Endpoint HTTP kompatibel OpenAI atau
  Anthropic Messages yang kamu daftarkan sendiri, lengkap dengan API key.

## Bagaimana runtime ditemukan

Discovery berjalan di host backend, bukan di browser. Browser tidak bisa
memeriksa isi PATH mesin lain, jadi deployment remote berada di luar cakupan
rilis ini.

Untuk tiap runtime, discovery mencari nama binary berikut di PATH — atau
memakai path yang kamu isi di kartu, kalau ada:

| Runtime | Binary yang dicari | Perintah metadata |
| --- | --- | --- |
| Codex | `codex`, `codex-cli` | `codex app-server --stdio` (JSON-RPC `model/list`) |
| Claude Code | `claude` | Claude Agent SDK, `Query.supportedModels()` |
| Antigravity | `agy` | `agy models` |

Binary bernama `antigravity` **sengaja tidak dicocokkan**. Nama itu dipakai
aplikasi desktop Antigravity, yang tidak pernah bisa menjawab `agy models`.
Kalau ia ikut dicocokkan, kegagalannya akan dilaporkan sebagai "versi tidak
didukung" dan justru menyembunyikan satu-satunya petunjuk yang menolong: CLI-nya
belum terpasang. Aplikasi desktop terpasang **bukan** berarti CLI-nya ada.

Discovery hanya membaca metadata. Ia tidak pernah mengirim prompt ke model,
membuka sesi tool, atau meneruskan stdout/stderr runtime ke browser.

Hasil discovery di-cache 15 menit. Tombol **Refresh** pada kartu memaksa
pemeriksaan ulang tanpa menunggu cache kedaluwarsa.

## Memasang tiap runtime

Perintah di bawah adalah yang ditampilkan kartu runtime saat binary-nya tidak
ditemukan. Versi yang sudah diverifikasi berjalan tercatat di
[`runtime-compatibility.md`](runtime-compatibility.md).

**Codex**

```bash
npm install -g @openai/codex
```

**Claude Code**

```bash
npm install -g @anthropic-ai/claude-code
```

**Antigravity** — ini memasang CLI `agy`, bukan aplikasi desktop:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Di Windows, kartu menampilkan `irm https://antigravity.google/cli/install.ps1 | iex`.

Dua catatan tentang installer Antigravity, karena keduanya mengubah mesinmu di
luar satu binary: skripnya menambahkan `export PATH="$HOME/.local/bin:$PATH"` ke
`~/.bashrc` dan `~/.profile`, dan CLI-nya memperbarui dirinya sendiri di latar
belakang saat dijalankan. Skrip itu juga dijalankan langsung dari internet —
kalau kamu lebih suka memeriksanya dulu, unduh ke berkas, baca, baru jalankan.

Setelah memasang, tekan **Refresh** di kartu. Discovery tidak memantau PATH.

## Autentikasi

Setiap runtime diautentikasi lewat CLI-nya sendiri, di luar aplikasi ini.
Aplikasi tidak menyimpan, membaca, atau meminta kredensial ketiga runtime, dan
tidak menampilkan isi token.

Baris **Auth** pada kartu sering menunjukkan `Unknown`. Itu jujur, bukan bug:
discovery belum punya cara resmi yang teruji untuk membaca status login setiap
runtime tanpa memanggil model. Katalog model yang terisi adalah petunjuk
praktis terbaik bahwa login masih berlaku — sesi yang kedaluwarsa biasanya
membuat daftar model kosong.

## Membaca kartu yang gagal

Kartu menampilkan status, satu kalimat penjelas, dan perintah yang bisa kamu
jalankan sendiri. Ketika binary tidak ditemukan, perintah itu adalah perintah
pemasangan. Ketika binary ada tapi discovery gagal, perintah itu adalah
**perintah yang dijalankan discovery** — menjalankannya di terminal
memperlihatkan pesan asli runtime, yang tidak bisa ditampilkan aplikasi karena
stdout runtime tidak diteruskan ke browser.

Status yang mungkin muncul:

| Status | Artinya |
| --- | --- |
| `Ready` | Binary ditemukan, versinya terbaca, katalog model terisi |
| `Needs login` | Runtime menyatakan dirinya belum terautentikasi |
| `Not installed` | Tidak ada binary yang cocok di PATH maupun di path yang diisi |
| `Unsupported version` | Binary ada, tetapi tidak menjawab `--version` dengan versi yang dikenali |
| `Unavailable` | Binary dan versinya terbaca, tetapi langkah metadata gagal |

Beberapa kode diagnostik yang sering muncul:

- `METADATA_TIMEOUT` — perintah metadata tidak selesai pada waktunya. Untuk
  Antigravity ini wajar terjadi pada jaringan lambat, karena `agy models`
  menanyakan katalog ke layanan alih-alih membaca berkas lokal.
- `MODEL_CATALOG_EMPTY` — runtime menjawab tanpa satu model pun. Biasanya sesi
  login yang sudah habis.
- `VERSION_UNREADABLE` — ada yang menjawab, tetapi bukan dengan versi yang
  dikenali. Sering berarti path menunjuk program lain yang kebetulan bernama
  sama.
- `AUTH_REQUIRED` — runtime terpasang tetapi belum login.

### Menunjuk executable secara manual

Kalau CLI yang benar ada tetapi tidak di PATH — atau ada beberapa salinan dan
kamu ingin memilih satu — isi **Executable path** pada kartu dengan path absolut.
Discovery akan memakai path itu alih-alih menelusuri PATH, dan perintah cek yang
ditampilkan kartu ikut memakai path tersebut, supaya kamu menguji binary yang
sama dengan yang dipakai aplikasi.

Kosongkan field itu untuk kembali menelusuri PATH.

## Custom endpoint

Endpoint HTTP didaftarkan sendiri di tab **Connections**, dengan nama, format
wire (OpenAI compatible atau Anthropic Messages), base URL, dan daftar model.

API key boleh diisi langsung, atau — lebih baik — diisi lewat **API key
environment variable**: kamu menyebut nama variabelnya di koneksi, dan nilainya
dibaca dari environment server. `.env.example` memuat beberapa nama yang lazim,
tetapi server tidak memilih provider atau variabel mana pun secara otomatis.

Dua hal yang perlu diketahui tentang kunci:

- Kunci **tidak pernah dikirim balik ke browser**. API koneksi hanya
  mengembalikan `hasKey`.
- Kunci yang diketik langsung **disimpan apa adanya** di `data/undagi.db`.
  Berkas itu, termasuk setiap salinan cadangannya, harus diperlakukan sebagai
  rahasia. Setelah upgrade dari build yang memakai `architech.db`, berkas lama
  itu tetap ada di disk dengan kunci yang sama; hapus setelah upgrade dipastikan
  berjalan baik. Memakai variabel environment membuat kunci tidak ikut masuk ke
  database maupun ke backup-nya.

## Memeriksa dari terminal

Kalau kamu lebih suka memeriksa tanpa membuka UI:

```bash
curl -s localhost:3000/api/runtimes | python3 -m json.tool
```

Memaksa pemeriksaan ulang, melewati cache 15 menit:

```bash
curl -s -X POST localhost:3000/api/runtimes/discover | python3 -m json.tool
```
