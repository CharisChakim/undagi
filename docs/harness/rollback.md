# Backup, migrasi, dan rollback

Dokumen ini menjelaskan di mana state aplikasi disimpan, migrasi apa yang
berjalan sendiri, dan cara mundur ke versi sebelumnya tanpa kehilangan riwayat.

Ringkasnya: mengembalikan **kode** itu mudah dan aman; mengembalikan **data**
setelah migrasi berjalan memerlukan backup, dan tidak semuanya bisa dibalik
otomatis.

## Di mana state disimpan

Seluruh state server ada dalam satu berkas SQLite:

```
data/undagi.db
```

Lokasinya bisa dipindah dengan environment variable `UNDAGI_DATA_DIR` (nama lama
`ARCHITECH_DATA_DIR` masih diterima sebagai fallback); paket desktop memakainya
karena direktori instalasi sering read-only. Tanpa variabel itu, path-nya
relatif terhadap direktori kerja proses.

Saat start, kalau `undagi.db` belum ada tapi `architech.db` ada di direktori
yang sama, berkas lama itu **disalin** ke `undagi.db`. Berkas lama dibiarkan
utuh dan perubahan sesudahnya tidak disinkronkan balik ke sana, jadi setelah
upgrade `architech.db` tinggal sebagai salinan pra-upgrade. Itulah berkas yang
dipulihkan kalau mundur ke build yang lebih tua dari penggantian nama ini.

Berkas itu memuat tiga belas tabel: `sessions`, `conversations`, `messages`,
`conversation_schema_migrations`, `connections`, `role_bindings`,
`mcp_servers`, `runs`, `run_events`, `run_approvals`, `run_evidence`,
`runtime_preferences`, dan `runtime_binary_paths`.

Dua hal yang perlu diingat sebelum menyalin berkas ini ke mana pun:

- Tabel `connections` menyimpan API key yang diketik langsung **apa adanya**.
  Setiap salinan database adalah salinan kunci-kunci itu. Koneksi yang memakai
  variabel environment tidak menaruh kunci di database.
- `data/` adalah runtime state dan tidak masuk ke git.

Preferensi per-perangkat — tema, bahasa, layout, konfigurasi LLM lama — ada di
`localStorage` browser, bukan di database. Rollback database tidak
menyentuhnya.

## Migrasi yang berjalan sendiri

Migrasi berjalan saat modul yang memilikinya dimuat, yaitu saat server start.
Tidak ada perintah migrasi terpisah.

### Percakapan: v1 → v2

Satu-satunya migrasi berversi saat ini. Ia mengubah tabel `conversations` dari
bentuk v1 (`session_id` wajib, tanpa kolom proyek) menjadi v2 (`session_id`
opsional, `project_id` opsional), supaya sebuah chat bisa berdiri tanpa proyek.

Yang dilakukannya, berurutan:

1. **Menyalin seluruh database** ke
   `undagi.db.pre-conversations-v2-<timestamp>.bak` di direktori yang sama
   (backup lama dari build sebelum penggantian nama tetap bernama
   `architech.db.pre-conversations-v2-<timestamp>.bak`).
   Kalau penyalinan gagal, migrasi berhenti dan tidak menyentuh apa pun.
2. Mengganti nama tabel lama, membuat tabel baru, dan memindahkan setiap baris.
   Baris v1 mendapat `project_id` dari `session_id`-nya, jadi tidak ada chat
   yang kehilangan proyeknya.
3. Mencatat versi di `conversation_schema_migrations`.

Seluruhnya berjalan dalam satu transaksi: kalau ada langkah yang gagal, database
kembali ke keadaan semula.

Database yang sudah berbentuk v2 tidak ditulis ulang dan tidak menghasilkan
backup baru. Menjalankan server berkali-kali tidak menambah berkas `.bak`.

Perilaku ini punya test-nya di
[`conversations.migration.test.ts`](../../server/agent/conversations.migration.test.ts),
memakai fixture schema v1 yang disalin dari backup nyata.

### Tabel lain

Tabel selain `conversations` dibuat dengan `CREATE TABLE IF NOT EXISTS` dan
tidak berversi. Konsekuensinya penting saat mundur maupun maju: kalau definisi
sebuah tabel berubah di kode, database yang sudah ada **tidak** ikut berubah —
tabel lamanya tetap dipakai apa adanya. Perubahan schema pada tabel-tabel ini
memerlukan migrasi eksplisit seperti yang dipunyai `conversations`.

### Run yang tertinggal saat start

Bukan migrasi, tetapi berjalan di saat yang sama dan perlu diketahui: setiap
kali store run dimuat, run yang berstatus `queued`, `running`,
`waiting_for_input`, atau `waiting_for_approval` ditandai `interrupted`.
Worker-nya tidak selamat dari restart, jadi status itu tidak boleh dibiarkan
tampak hidup. Run yang sudah selesai tidak disentuh, dan run `interrupted`
tidak bisa dilanjutkan di tempat — ia berhenti di situ. Perilaku ini punya
test-nya di [`store.test.ts`](../../server/runs/store.test.ts).

Perlu dicatat: penandaan ini murni lokal. Aplikasi **tidak** menanyai
Codex/Claude Code/Antigravity apakah sesi eksternalnya masih hidup, jadi sesi
di sisi provider bisa saja masih berjalan setelah Undagi menganggapnya mati.

## Mundur ke versi sebelumnya

### Kalau belum ada migrasi yang berjalan

Cukup kembalikan kode:

```bash
git checkout <commit-sebelumnya>
npm install
npm run build
```

Database tidak perlu disentuh — kecuali mundurnya melewati penggantian nama
ke Undagi, lihat bagian berikutnya.

### Kalau mundur ke build sebelum penggantian nama

Build lama membaca `data/architech.db`, bukan `data/undagi.db`. Kalau hanya
kodenya yang dikembalikan, ia membuka `architech.db` yang tinggal sebagai
salinan pra-upgrade, sehingga semua pekerjaan sesudah upgrade tampak hilang.
Sebelum menjalankan build lama, bawa database sekarang ke nama lama:

```bash
cp data/architech.db data/architech.db.pre-rollback
cp data/undagi.db data/architech.db
```

Sebelum maju lagi ke build baru, pindahkan atau hapus `data/undagi.db`. Selama
berkas itu ada, `architech.db` tidak disalin ulang dan perubahan yang dibuat di
build lama diabaikan.

### Kalau migrasi percakapan sudah berjalan

Mematikan flag atau mengembalikan kode **tidak** mengembalikan schema. Tabel
`conversations` tetap dalam bentuk v2, dan kode v1 tidak bisa membacanya.

Prosedurnya:

1. **Hentikan server.** Memulihkan database di bawah proses yang berjalan akan
   membuat dua keadaan bercampur.
2. **Simpan keadaan sekarang**, jangan langsung ditimpa — kamu akan
   membutuhkannya kalau ternyata ingin maju lagi:

   ```bash
   cp data/undagi.db data/undagi.db.before-rollback
   ```

3. **Pulihkan backup pra-migrasi** ke nama berkas yang dibaca build tujuan.
   Schema v1 hanya ada di build sebelum penggantian nama, jadi tujuannya
   `data/architech.db`. Backup dari build itu bernama
   `architech.db.pre-conversations-v2-<timestamp>.bak`; kalau migrasinya
   berjalan di build yang sudah memakai nama Undagi, namanya
   `undagi.db.pre-conversations-v2-<timestamp>.bak`:

   ```bash
   cp data/architech.db.pre-conversations-v2-<timestamp>.bak data/architech.db
   ```

4. Kembalikan kode ke versi yang cocok, lalu jalankan lagi.

**Apa yang hilang:** semua yang terjadi setelah backup itu dibuat — chat baru,
pesan baru, run, PRD, dan task. Backup adalah snapshot pada saat migrasi, bukan
salinan berkelanjutan. Kalau kehilangan itu tidak dapat diterima, ekspor dulu
yang kamu butuhkan dari instalasi yang sekarang sebelum memulihkan.

Tidak ada migrasi balik otomatis dari v2 ke v1. Jangan menghapus baris atau
kolom untuk "membalik" migrasi dengan tangan — riwayat lebih berharga daripada
schema yang rapi.

### Sebelum migrasi berikutnya

Ambil backup sendiri sebelum menjalankan versi yang membawa perubahan schema.
Backup otomatis hanya dibuat oleh migrasi percakapan; migrasi lain di masa depan
belum tentu punya kebiasaan yang sama.

```bash
cp data/undagi.db data/undagi.db.$(date +%Y%m%d-%H%M%S).bak
```

## Memeriksa keadaan schema

Perintah di bawah memakai CLI `sqlite3`. Kalau tidak terpasang, Node bisa
menggantikannya: `node -e "const {DatabaseSync}=require('node:sqlite');
console.log(new DatabaseSync('data/undagi.db').prepare('<query>').all())"`.

Versi migrasi yang tercatat:

```bash
sqlite3 data/undagi.db "SELECT name, version, applied_at FROM conversation_schema_migrations;"
```

Bentuk tabel percakapan saat ini — kalau ada kolom `project_id`, database sudah
v2:

```bash
sqlite3 data/undagi.db "PRAGMA table_info(conversations);"
```

Backup yang tersedia:

```bash
ls -la data/*.bak
```
