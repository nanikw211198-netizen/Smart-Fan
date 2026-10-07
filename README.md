# Smart Fan – Backend PHP

Struktur folder:

```
smartfan-php/
├── smartfan.sql              # Skema database (jalankan ini dulu di MySQL)
├── config/
│   └── database.php          # Koneksi + PERGANTIAN DATABASE (local/production)
├── helpers/
│   └── response.php          # Helper JSON response, CORS, session
└── api/
    ├── auth.php               # Register, login, logout, cek sesi (Profil/Akun)
    ├── profile.php             # Lihat & update profil, ganti password (Profil/Akun)
    ├── devices.php             # CRUD & kontrol kipas (Data Kipas)
    ├── schedules.php           # CRUD jadwal (Jadwal)
    ├── sensor_data.php         # Kirim & ambil data sensor (Data Sensor)
    ├── settings.php            # Get/update pengaturan (Pengaturan Pengguna)
    └── statistics.php          # Rekap & catat statistik (Statistik Pengguna)
```

## 1. Setup database

Import `smartfan.sql` ke MySQL/MariaDB (contoh via phpMyAdmin atau CLI):

```bash
mysql -u root -p < smartfan.sql
```

### Memulihkan tabel `devices` yang terhapus

Jika tabel `devices` terhapus, pilih database SmartFan di phpMyAdmin, buka tab
**Import**, lalu jalankan `api/restore_devices.sql`. Script ini membuat ulang
tabel beserta empat perangkat contoh agar kontrol tampil kembali. Data perangkat
lama yang sudah terhapus hanya dapat dipulihkan dari backup/ekspor database.

## 2. Pergantian database (dev ⇄ production)

Semua koneksi diatur di **`config/database.php`** lewat class `Database`.
Ada dua (atau lebih) konfigurasi tersimpan sekaligus di array `$configs`:

```php
private static array $configs = [
    'local' => [ ... ],
    'production' => [ ... ],
];
```

Untuk berpindah, ubah salah satu dari dua cara ini:

- **Ubah konstanta di file** — ganti baris:
  ```php
  define('ACTIVE_ENV', getenv('SMARTFAN_ENV') ?: 'local');
  ```
  menjadi `'production'` (atau environment lain yang kamu tambahkan).

- **Tanpa mengubah kode** — set environment variable sebelum menjalankan PHP:
  ```bash
  SMARTFAN_ENV=production php -S localhost:8000
  ```

Tambahkan environment baru cukup dengan menambah key baru di array `$configs` (misalnya `'staging'`).

## 3. Menjalankan server lokal

```bash
cd smartfan-php
php -S localhost:8000
```

Backend akan bisa diakses di `http://localhost:8000/api/...`.

## 4. Daftar endpoint

| Fitur (menu)          | Method | Endpoint                                   | Keterangan |
|------------------------|--------|---------------------------------------------|------------|
| Profil/Akun            | POST   | `/api/auth.php?action=register`             | Daftar akun baru |
| Profil/Akun            | POST   | `/api/auth.php?action=login`                | Login |
| Profil/Akun            | POST   | `/api/auth.php?action=logout`               | Logout |
| Profil/Akun            | GET    | `/api/auth.php?action=me`                   | Cek sesi login |
| Profil/Akun            | GET    | `/api/profile.php`                          | Lihat profil |
| Profil/Akun            | PUT    | `/api/profile.php`                          | Update profil |
| Profil/Akun            | PUT    | `/api/profile.php?action=password`          | Ganti password |
| Data Kipas              | GET    | `/api/devices.php`                          | Daftar kipas |
| Data Kipas              | GET    | `/api/devices.php?id=1`                     | Detail kipas |
| Data Kipas              | POST   | `/api/devices.php`                          | Tambah kipas |
| Data Kipas              | PUT    | `/api/devices.php?id=1`                     | Update/kontrol kipas |
| Data Kipas              | DELETE | `/api/devices.php?id=1`                     | Hapus kipas |
| Jadwal                  | GET    | `/api/schedules.php`                        | Daftar jadwal |
| Jadwal                  | POST   | `/api/schedules.php`                        | Tambah jadwal |
| Jadwal                  | PUT    | `/api/schedules.php?id=1`                   | Update jadwal |
| Jadwal                  | DELETE | `/api/schedules.php?id=1`                   | Hapus jadwal |
| Data Sensor              | GET    | `/api/sensor_data.php?device_id=1&limit=50` | Riwayat sensor |
| Data Sensor              | GET    | `/api/sensor_data.php?device_id=1&latest=1` | Data sensor terbaru |
| Data Sensor              | POST   | `/api/sensor_data.php`                      | Kirim data sensor (dari ESP32) |
| Pengaturan Pengguna     | GET    | `/api/settings.php`                         | Lihat pengaturan |
| Pengaturan Pengguna     | PUT    | `/api/settings.php`                         | Update pengaturan |
| Statistik Pengguna      | GET    | `/api/statistics.php?range=week`            | Rekap statistik |
| Statistik Pengguna      | POST   | `/api/statistics.php`                       | Catat/ubah statistik harian |

Semua endpoint (kecuali `auth.php` dan `sensor_data.php` POST dari ESP32) memerlukan
login terlebih dahulu — session PHP disimpan lewat cookie, jadi pastikan request
`fetch` di `app.js` menyertakan `credentials: 'include'`.

## 5. Catatan integrasi ke `app.js`

Saat ini `app.js` masih menyimpan semua state di `localStorage`
(`smartfan_state`). Untuk menyambungkannya ke backend ini, ganti bagian yang
menulis/membaca `state` langsung dengan pemanggilan `fetch()` ke endpoint di
atas, misalnya:

```js
fetch('http://localhost:8000/api/devices.php', { credentials: 'include' })
  .then(r => r.json())
  .then(res => {
    if (res.success) state.devices = res.data;
  });
```

Jangan lupa sesuaikan `Access-Control-Allow-Origin` di `helpers/response.php`
jika frontend dan backend berjalan di domain/port berbeda dan butuh cookie
(gunakan origin spesifik, bukan `*`, saat `credentials: 'include'` dipakai).
