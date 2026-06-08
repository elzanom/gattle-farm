# Cattle Farm Autonomous Bot 🌾🤖

Bot otomatisasi untuk permainan **Cattle Farm** (`cattlefarmonly.my.id`) menggunakan Node.js dan GramJS (MTProto). Mendukung **multi-account** secara konkuren, klaim iklan (ads), panen (harvest), upgrade hewan, dan konversi produk ke USDT secara otomatis.

---

## Fitur Utama

- **Multi-Account Support**: Menjalankan banyak akun secara terpisah dengan manajemen sesi Telegram dan token JWT masing-masing.
- **Concurrent Execution**: Berjalan secara konkuren antara:
  - `adsLoop`: Menonton/klaim iklan setiap 1 detik untuk mengumpulkan koin.
  - `harvestLoop`: Klaim hasil ternak, melakukan upgrade otomatis, dan menukar produk ke USDT setiap 60 menit (atau sesuai interval).
- **Auto Re-authentication**: Otomatis memperbarui token JWT game jika kedaluwarsa (expired) menggunakan sesi Telegram yang tersimpan.
- **Keamanan Sesi**: Sesi Telegram disimpan secara lokal di folder `sessions/` sehingga tidak memerlukan login ulang (OTP) setelah login pertama berhasil.

---

## Persyaratan Sistem

- **Node.js** (Versi 18 ke atas disarankan)
- **NPM** (Bawaan Node.js)

---

## Instalasi

1. **Clone atau Unduh** repositori ini ke komputer/server Anda.
2. Buka terminal di direktori proyek dan jalankan perintah berikut untuk menginstal dependensi:
   ```bash
   npm install
   ```

---

## Konfigurasi

1. Salin berkas `config.example.json` menjadi `config.json`:
   ```bash
   cp config.example.json config.json
   ```
2. Buka berkas `config.json` menggunakan text editor Anda, lalu sesuaikan nilainya:
   ```json
   {
     "baseUrl": "https://www.cattlefarmonly.my.id",
     "botUsername": "cattlefarmonly12_bot",
     "intervalMinutes": 60,
     "accounts": [
       {
         "name": "Akun_1",
         "apiId": 12345678,
         "apiHash": "api_hash_akun_1_anda",
         "phoneNumber": "628xxxxxxxxxx"
       },
       {
         "name": "Akun_2",
         "apiId": 87654321,
         "apiHash": "api_hash_akun_2_anda",
         "phoneNumber": "628yyyyyyyyyy"
       }
     ]
   }
   ```
   > 💡 **Catatan**: Dapatkan `apiId` dan `apiHash` Telegram Anda melalui situs resmi [my.telegram.org/apps](https://my.telegram.org/apps).

---

## Mengimpor Sesi Telegram yang Sudah Ada (Bypass OTP)

Jika Anda sudah memiliki string sesi (session string) GramJS sebelumnya atau file sesi, Anda bisa langsung memasukkannya tanpa perlu verifikasi kode OTP ulang:

1. Buat folder untuk akun Anda di dalam direktori `sessions/` dengan struktur seperti berikut:
   ```
   sessions/
   └── [Nama_Akun_Sesuai_Config]/
       └── gramjs.session
   ```
   *Contoh untuk nama akun `"Account 1"` di `config.json`:*
   ```
   sessions/
   └── Account 1/
       └── gramjs.session
   ```
2. Tulis atau tempelkan **string sesi GramJS** Anda ke dalam file `gramjs.session` tersebut sebagai teks biasa tanpa spasi/baris baru tambahan.
3. Saat bot dijalankan, bot akan mendeteksi sesi tersebut dan langsung masuk tanpa meminta kode OTP.

---

## Cara Menjalankan Bot

Anda dapat menjalankan bot dengan beberapa mode berikut (tersedia di `package.json`):

### 1. Jalankan Mode Konkuren (Default)
Mode ini akan memproses klaim iklan (setiap 1 detik jika tersedia) sekaligus melakukan panen & upgrade berkala secara terus-menerus.
Pada mode ini, **Server Dashboard Web** otomatis diaktifkan.
```bash
npm start
```

---

## Dashboard Monitoring Web 📊

Saat Anda menjalankan bot dalam mode default (`npm start`), bot akan mengaktifkan server web internal. 

- **Alamat URL**: `http://localhost:3003` (atau sesuai port yang diatur di `config.json` pada `"dashboardPort"`).
- **Fitur Dashboard**:
  - **Global Summary**: Total akun, total klaim iklan keseluruhan, total koin, dan total pendapatan USDT kumulatif.
  - **Status Akun**: Menampilkan nama akun beserta badge status real-time (`active`, `authenticating`, `idle`, `error`).
  - **Saldo Akun**: Rincian koin, rupiah, dan USDT per akun.
  - **Status Peternakan (Pet Farm)**: Level hewan, jumlah produk terkumpul, dan progress bar/countdown waktu mundur hingga panen berikutnya.
  - **Statistik Akun**: Total iklan, panen, daily coin, upgrade, dan estimasi USDT yang telah dihasilkan per akun.
  - **Log Aktivitas**: Menampilkan log konsol khusus untuk akun tersebut dengan pewarnaan log yang interaktif.

---
### 2. Cek Status Akun saja (Dry-Run)
Gunakan mode ini untuk melihat statistik koin, level hewan, waktu panen berikutnya, dan saldo USDT tanpa melakukan tindakan/klaim apa pun.
```bash
npm run dry-run
```

### 3. Jalankan Satu Kali Siklus (Once)
Klaim panen, lakukan upgrade dan konversi satu kali saja lalu bot langsung keluar (exit).
```bash
npm run once
```

### 4. Perbarui Sesi Login (Re-authentication)
Untuk memaksa login ulang dan mendapatkan token baru pada semua akun atau akun tertentu:
```bash
# Untuk semua akun
npm run reauth

# Untuk akun spesifik (ganti AccountName dengan nama di config.json)
node cattle_bot.js --reauth "AccountName"
```

---

## Keamanan & Pengunggahan ke GitHub

File penting berikut **telah didaftarkan di `.gitignore`** agar tidak terunggah ke repositori publik demi keamanan data Anda:
* `config.json` (Berisi API ID, API Hash, nomor telepon asli)
* `sessions/` (Kunci akses sesi Telegram Anda)
* `tokens/` (Token akses JWT game)
* `node_modules/` (Folder pustaka dependensi)
