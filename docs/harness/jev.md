# Jev: keputusan opsional (TypeSafe AI)

Dokumen ini menjelaskan fitur opsional **Jev decisions**: apa itu Jev, cara
menyalakannya, apa yang dilakukan tiap sakelar, teks apa yang dikirim keluar
dari mesinmu, dan apa yang terjadi kalau layanannya gagal. Key Jev disimpan
dengan cara yang sama seperti key koneksi; lihat juga
[`connections.md`](connections.md) dan [`rollback.md`](rollback.md).

Ringkasnya: fitur ini **mati secara default**, tidak pernah wajib, dan hanya
memberi **saran**. Jev tidak menyetujui, memblokir, mengubah, atau menjalankan
apa pun. Setiap kegagalan atau timeout diam-diam kembali ke perilaku biasa.

## Apa itu Jev

Jev adalah model "System One" pertama dari TypeSafe AI. Ia menerima sebuah
`state` berupa teks, menilainya terhadap pertanyaan bertipe, lalu mengembalikan
jawaban bertipe:

| Tipe jawaban | Bentuknya |
| --- | --- |
| Choice | Memilih satu opsi, lengkap dengan probabilitas tiap opsi |
| Score | Level pada sebuah rubrik, dibobot probabilitas |
| Noul | Probabilitas ya/tidak |

Choice dan Score juga menyertakan nilai confidence. Jev **tidak menulis
balasan, kode, atau penjelasan**, dan hanya menerima input teks.

Ia layanan hosted: `POST https://api.typesafe.ai/v1/systemone` dengan bearer
key, route model `jev-latest`. Saat dokumen ini ditulis, aksesnya masih early
access (waitlist). Rujukan resmi ada di <https://docs.typesafe.ai>.

Angka performa atau harga yang diklaim vendor tidak diulang di sini dan tidak
diverifikasi oleh Undagi.

## Yang perlu diketahui dulu

- **Butuh key TypeSafe milikmu sendiri.** Undagi tidak membawa key, dan akses
  ke Jev masih early access.
- **Jawaban Jev adalah probabilitas, bukan jaminan.** Angka "sekitar 80%" bisa
  saja salah; karena itu semua hasilnya hanya saran yang bisa kamu abaikan.
- **Jev tidak menggantikan model penulis.** Plan, PRD, dan Tasks tetap
  dihasilkan oleh model pembuat teks yang kamu hubungkan lewat
  [`connections.md`](connections.md). Tanpa model itu, hanya sebagian kecil
  alur yang terbantu.
- **Ini satu-satunya bagian Undagi yang berbicara dengan layanan pihak ketiga**
  selain penyedia model yang kamu atur sendiri. Baca bagian [Privasi](#privasi).

## Cara menyalakan

1. Dapatkan API key TypeSafe (lewat early access mereka).
2. Buka **Settings → Agent settings → Jev decisions (optional)**.
3. Nyalakan sakelar utama (master switch), tempel key, lalu simpan.
4. Tekan **Test connection**. Kalau berhasil, key diterima dan layanan terjangkau.
5. Nyalakan sakelar fitur yang kamu mau (lihat bagian berikutnya). Keempatnya
   berdiri sendiri; menyalakan satu tidak menyalakan yang lain.

Sakelar fitur hanya berpengaruh kalau sakelar utama menyala **dan** key
tersimpan. Tanpa keduanya, tidak ada permintaan yang dikirim.

Seperti key koneksi, UI hanya tahu bahwa key ada (`hasKey`); nilainya tidak
dikirim balik ke browser. Key **disimpan apa adanya** (plaintext) di
`data/undagi.db`, sama seperti key koneksi yang diketik langsung — lihat
[Mencabut key](#mencabut-key-atau-mematikan-fitur) untuk konsekuensinya.

## Empat sakelar

Semuanya advisory. Tidak ada satu pun yang mengubah data proyek, papan task,
atau keputusan persetujuan.

### 1. Understand chat requests

Kalau sebuah pesan chat terlihat seperti permintaan untuk merencanakan proyek,
menulis PRD, atau membuat task, **dan** langkah itu memang yang berikutnya,
Undagi menampilkan hint yang bisa ditutup dan menawarkan membuka panel yang
sesuai. Hint hanya muncul kalau confidence-nya minimal 70%. Undagi **tidak
pernah pindah panel sendiri**; kamu yang memutuskan menekannya.

### 2. Check if an idea is clear enough

Di Plan intake muncul satu baris pelan seperti "about N% ready to plan": perkiraan
seberapa siap idenya untuk dibuat menjadi plan. Tombol **Generate** tidak pernah
dinonaktifkan oleh angka ini; kamu boleh menghasilkan plan berapa pun nilainya.

### 3. Rate risk on permission requests

Kartu persetujuan mendapat badge **low**, **medium**, atau **high**. Badge ditampilkan **setelah** kartu muncul,
jadi tidak pernah menunda kartu. Kamu tetap yang memutuskan menyetujui atau
menolak. Di mode Auto dan Full-access tidak ada kartu, sehingga tidak ada badge.

### 4. Suggest task dependencies

Setelah task dihasilkan, muncul daftar yang bisa ditutup berisi pasangan task
yang mungkin saling bergantung (minimal 80%). Ini hanya tampilan: papan task
tidak berubah, dan aturan bahwa sebuah task menunggu dependency-nya tetap
memakai dependency yang sudah ada di task itu.

## Privasi

**Selama sebuah sakelar menyala, teks yang dinilai dikirim ke
`api.typesafe.ai`.** Yang dikirim per fitur:

| Sakelar | Teks yang dikirim |
| --- | --- |
| Understand chat requests | Pesan chat |
| Check if an idea is clear enough | Deskripsi plan |
| Rate risk on permission requests | Perintah dan working folder dari permintaan izin |
| Suggest task dependencies | Judul task, target file, dan potongan instruksi |

Nilai yang tampak seperti rahasia (misalnya token atau key dalam sebuah
perintah) disamarkan sebelum dikirim. Ini upaya terbaik, **bukan jaminan**:
pola yang tidak dikenali bisa lolos. Kalau pesan, deskripsi, atau perintahmu
mungkin memuat data yang tidak boleh keluar dari mesin, biarkan sakelar
terkait mati.

Kalau semua sakelar mati — atau sakelar utama mati — **tidak ada permintaan yang
dikirim dan tidak ada teks yang keluar**.

Apa yang dilakukan TypeSafe dengan teks yang mereka terima diatur oleh
ketentuan mereka, bukan oleh Undagi. Baca dokumentasi dan kebijakan mereka
sebelum mengirim teks proyek yang sensitif.

## Kalau Jev gagal

Semua kegagalan ditangani sama: **diam-diam kembali ke perilaku biasa.** Key
salah, jaringan putus, layanan sibuk, timeout, atau jawaban yang tidak bisa
dibaca — hasilnya hanya berupa hint, baris, badge, atau daftar yang tidak
muncul. Chat, Plan intake, kartu persetujuan, dan papan task bekerja persis
seperti saat fitur ini mati. Tidak ada dialog galat dan tidak ada yang tertahan
menunggu Jev.

Konsekuensinya: **tidak adanya hint bukan berarti "tidak ada yang perlu
diperhatikan".** Kadang ia hanya berarti permintaannya gagal. Gunakan **Test
connection** untuk membedakannya.

## Pemecahan masalah

Mulai dari tombol **Test connection** di panel Jev decisions. Hasilnya
menampilkan pesan galat, yang tidak dimunculkan di tempat lain karena
kegagalan saat pemakaian biasa memang disembunyikan.

| Gejala | Kemungkinan penyebab | Yang dilakukan |
| --- | --- | --- |
| **401** | Key salah, salah salin (spasi di ujung), atau sudah dicabut | Tempel ulang key dari TypeSafe, simpan, tekan **Test connection** lagi |
| **429** atau **529** | Terkena batas laju, atau layanan sedang sibuk | Coba lagi nanti. Selama itu hint hanya tidak muncul; tidak ada yang rusak |
| Timeout | Jaringan lambat, proxy, atau firewall yang menahan `api.typesafe.ai` | Permintaan biasa diabaikan diam-diam. Periksa koneksi dari mesin yang menjalankan backend, lalu tekan **Test connection** |
| Test berhasil, tetapi tidak ada hint | Sakelar fiturnya mati, atau confidence di bawah ambang (70% untuk chat, 80% untuk dependency) | Periksa sakelarnya. Hasil di bawah ambang sengaja tidak ditampilkan |
| Tidak ada badge risiko | Sedang di mode Auto atau Full-access, atau sakelar risiko mati | Di mode itu kartu persetujuan memang tidak muncul |
| Sakelar menyala, tetapi tidak ada yang terjadi | Sakelar utama mati, atau key belum tersimpan | Nyalakan sakelar utama dan pastikan key tersimpan |

Untuk kode galat lain, pesan pada hasil **Test connection** dan dokumentasi
TypeSafe adalah sumber yang benar. Undagi hanya meneruskan apa yang dijawab
layanannya.

## Mencabut key atau mematikan fitur

- **Mematikan sebagian:** matikan sakelar fiturnya. Fitur lain tetap jalan.
- **Menghentikan semua pengiriman:** matikan sakelar utama. Key tetap
  tersimpan, tetapi tidak dipakai.
- **Menghapus key:** tekan **Remove key** di panel Jev decisions. Setelah itu
  Jev otomatis tidak aktif karena tidak ada key.

Key ditulis ke `data/undagi.db`, jadi menghapusnya dari UI **tidak** menghapus
salinan yang sudah ada di tempat lain: berkas `*.bak` yang dibuat migrasi,
cadangan yang kamu buat sendiri, dan `architech.db` sisa upgrade (kalau masih
ada) bisa memuat key itu selama salinannya dibuat sebelum key dihapus. Jika key
pernah bocor atau salinan lama tidak bisa kamu kuasai, **cabut key itu di sisi
TypeSafe** dan buat yang baru. Lokasi berkas dan cara kerja backup dijelaskan di
[`rollback.md`](rollback.md).
