# Design Guidance: referensi gaya bitwiseinvestments.com

Dokumen ini adalah referensi gaya untuk Overflow Trade. Isinya diekstrak dari HTML halaman utama Bitwise yang kamu simpan (`Crypto_Index_Fund__ETF_Provider___Bitwise_Asset_Management.html`). Situsnya dibangun dengan Next.js + Stitches, jadi semua token di bawah dibaca langsung dari CSS variables-nya (`--colors-*`, `--fonts-*`, `--space-*`, `--radii-*`, `--shadows-*`).

Setiap nilai diberi label sumbernya:
- **[Terukur]** artinya diambil persis dari file HTML.
- **[Perkiraan]** artinya tidak ada di file. Ukuran font misalnya ada di file CSS terpisah (`/_next/static/css/…`) yang tidak ikut tersimpan.

---

## 1. Konsep & karakter

- **Nada:** institusional, tenang, dan bisa dipercaya, seperti manajer aset atau ETF provider, bukan exchange crypto yang ramai. Tagline yang dipakai: *"Crypto is complicated. We make it clear."*
- **Kesan visual:**
  - Dominan putih dan abu kebiruan (slate) dengan banyak ruang kosong.
  - Satu aksen hijau (emerald) yang dipakai hemat.
  - Teks hampir hitam kebiruan.
  - Ada section gelap (slate-15) sebagai jeda kontras.
- **Ciri khas tipografi:**
  - Judul memakai serif display lebar (**Items**) dengan line-height 1, sedikit letter-spacing, dan berat tipis (350).
  - Kata kunci di judul ditulis *italic*, contohnya: "Crypto Funds Backed by *Crypto Specialists*", "Crypto is *complicated*. We make it *clear*."
  - Teks UI dan isi memakai grotesk modern (**Neue Montreal**).
- **Detail kecil yang konsisten:**
  - Label/eyebrow uppercase dengan spasi lebar, seperti "WHY BITWISE" dan "INSIGHTS".
  - Tombol uppercase berukuran kecil (12px) dengan sudut hampir kotak (4px).
  - Shadow berlapis yang sangat halus.
  - Transisi lambat dan lembut (300–700ms ease-in-out).
- **Struktur halaman utama (urutan)** **[Terukur]**:
  1. **Utility bar:** link "Visit European website", "Investor Portal", "Expert Portal".
  2. **Nav:** latar putih.
  3. **Hero:**
     - Pill kecil di atas: "Get the Weekly CIO Memo".
     - H1 serif dengan kata italic.
     - Paragraf satu kalimat.
     - Dua tombol: "Learn More" (outline) dan "Start Investing" (hijau).
     - Badge produk: "Now Available on NYSE · BHYP".
  4. **Logo investor:** "Backed By Leading Institutions…", baris logo monokrom dan disclaimer kecil.
  5. **Why Bitwise:**
     - Eyebrow, H2, lalu tiga poin H3 + paragraf.
     - CTA "Invest Now".
  6. **Investments:** eyebrow, H2 dengan italic, lalu grid produk/fund.
  7. **Insights:**
     - H2 "Crypto is *complicated*. We make it *clear*."
     - Tiga kartu artikel: label kategori, tanggal, judul, ringkasan, "Read More".
     - Tombol "View All", lalu form newsletter (Email + Submit).
  8. **CTA penutup:** H2 "Let *Bitwise* help you take the next step in your *crypto journey*." dengan dua tombol.
  9. **Footer gelap:**
     - "A team of crypto experts at your fingertips." dan "Connect with Us".
     - Alamat kantor.
     - Disclaimer hukum panjang dengan teks kecil abu.

---

## 2. Palet warna [Terukur]

Semua warna dikonversi dari HSL di CSS.

### Brand (hijau emerald, hue 146)
| Token | HSL | HEX | Fungsi |
|---|---|---|---|
| brand100 | 146 100% 95% | `#e5fff1` | latar tint sangat muda |
| brand200 | 146 68% 93% | `#e1f9ec` | latar badge/tag |
| brand300 | 146 68% 71% | `#83e7ae` | aksen ringan, ilustrasi |
| brand400 | 146 69% 54% | `#39db7f` | aksen cerah di latar gelap |
| **brand500 = primary** | 146 71% 46% | **`#22c96a`** | tombol utama, link aktif |
| brand600 | 146 85% 35% | `#0da54f` | hover tombol primary |
| brand800 = primaryHover | 146 88% 22% | `#076932` | hover gelap, teks hijau di latar terang |

### Netral (slate, sedikit kebiruan)
| Token | HEX | Fungsi |
|---|---|---|
| white | `#ffffff` | **background** utama dan nav |
| slate1 | `#fcfcfd` | input disabled |
| slate2 | `#f9fafb` | latar section alternatif dan utility bar |
| slate3 | `#f0f2f4` | latar ikon bulat |
| slate4 | `#ebedef` | **border** default dan hover utility bar |
| slate5 | `#e6e8eb` | border kartu |
| slate6 | `#e0e3e6` | border input dan tombol sekunder |
| slate7 | `#d7dbdf` | divider |
| slate8 | `#c1c8cd` | border input saat hover |
| slate9 | `#889096` | teks placeholder |
| slate10 | `#7d868c` | border input saat fokus, teks tersier |
| slate11 | `#697177` | **eyebrow/label**, teks sekunder |
| slate12 | `#4d555c` | paragraf sekunder, kutipan |
| slate13 | `#252d31` | permukaan di section gelap |
| slate14 | `#1c262c` | kartu di section gelap |
| **slate15 = title/link/logo** | **`#11181c`** | warna judul, logo, latar section gelap dan footer |
| slate16 | `#020304` | hitam terdalam |

### Warna status (skala Radix 1–12, untuk grafik/status)
- **Green:**
  - green9 `#30a46c`, green10 `#2b9a66`, green11 `#218358`
  - green3 `#e6f6eb` untuk latar
- **Red:**
  - red9 `#e5484d`, red10 `#dc3e42`, red11 `#ce2c31`
  - red3 `#feebec` untuk latar
- **Blue:** blue9 `#0090ff`, blue11 `#0d74ce`
- **Amber:** amber9 `#ffc53d`, amber11 `#ab6400`
- **Purple:** purple9 `#8e4ec6`
- **Yellow:** yellow9 `#ffe629`
- **Transparan:** blackA1–A12 (`rgba(0,0,0,.05)` sampai `.95`) dan slateA1–A12 untuk overlay.

### Aturan warna
1. **Proporsi:** sekitar 85% putih/slate terang, 10% slate-15 (teks dan section gelap), maksimal 5% hijau.
2. Hijau **hanya** untuk aksi utama (tombol primary, link penting) dan sorotan data positif. Jangan dipakai untuk latar besar.
3. Section gelap memakai latar slate15 `#11181c`, judul putih, teks slate8/slate9, dan aksen brand400 `#39db7f`.
4. Teks judul memakai slate15. Paragraf memakai slate12/slate11, bukan hitam murni.
5. Situs ini **hanya punya mode terang** (tidak ada token dark mode di file). Dark mode untuk Overflow Trade harus diturunkan sendiri dari palet slate gelap di atas.

---

## 3. Tipografi

### Font [Terukur]
| Peran | Font | File | Fallback |
|---|---|---|---|
| Heading / display (`--fonts-heading`, `--fonts-serif`) | **Items** (variable, Roman + Italic) | `/fonts/items/ItemsRomanVF.woff2`, `ItemsItalicVF.woff2` | `serif` |
| Paragraf & UI (`--fonts-paragraph`, `--fonts-sans`) | **PP Neue Montreal** (variable) | `/fonts/neueMontreal/PPNeueMontreal-Variable.woff2` | `apple-system, sans-serif` |

**Berat font** **[Terukur]:**
- Serif: Regular **350** dan Medium 500.
- Sans: Regular **400**, Medium **550**, Bold **650**. Ini variable font, jadi beratnya bukan kelipatan 100.

**Line-height:** heading 1, sub-heading 1.25, paragraf 1.5.

⚠️ **Lisensi:**
- **PP Neue Montreal** dari Pangram Pangram gratis hanya untuk penggunaan personal. Untuk website komersial perlu membeli lisensi.
- **Items** adalah font komersial dari foundry independen. Font ini tidak gratis dan file-nya tidak boleh diambil dari situs Bitwise. Beli lisensinya dari foundry-nya.

**Pengganti gratis kalau tidak membeli lisensi:**
- Neue Montreal → **Inter** atau **Instrument Sans** (Google Fonts).
- Items → **Instrument Serif** atau **Fraunces** (Google Fonts). Fraunces punya italic dan axis "soft/wonk" yang mirip nuansa Items.

### Gaya teks [Terukur]
| Elemen | Font | Berat | Gaya |
|---|---|---|---|
| **H1** | Items | 350 | slate15, line-height 1, letter-spacing 0.025em, `font-stretch: 550%` (lebar maksimum axis), margin-bawah 1.75rem. Kata kunci pakai `<em>` (Items Italic) |
| **H2** | Items | 350 | sama dengan H1, ukuran lebih kecil, margin-bawah 1.25rem, kata kunci italic |
| **H4** | Items | 350 | sama, margin-bawah 0.75rem |
| **H5** | Neue Montreal | 550 | slate15, line-height 1.25, margin-bawah 0.5rem (judul kartu/poin) |
| **H6 / eyebrow** | Neue Montreal | 550 | slate11, **UPPERCASE**, letter-spacing **0.125em**, line-height 1, margin-bawah 1rem (contoh: "WHY BITWISE", "INSIGHTS") |
| Paragraf | Neue Montreal | 400 | slate12, line-height 1.5 |
| Kutipan / catatan | Neue Montreal | 400 italic | slate12, line-height 1.4, rata tengah, maks 52rem |
| Label kecil / tag | Neue Montreal | 550 | 0.75rem, uppercase, letter-spacing 0.08em |
| Teks kecil / disclaimer | Neue Montreal | 400 | 0.75rem dan 0.875rem (paling sering muncul) |

**Skala ukuran** **[Perkiraan]:** nilai `---fontLevel*` dan `---h1…h6` didefinisikan di file CSS eksternal yang tidak ikut tersimpan. Usulan skala yang sesuai proporsi situs, dari mobile ke desktop dengan `clamp()`:

| Level | Ukuran |
|---|---|
| H1 | 2.75rem → 5rem |
| H2 | 2.25rem → 3.5rem |
| H4 | 1.5rem → 2rem |
| H5 | 1.125rem → 1.25rem |
| Eyebrow | 0.75rem → 0.8125rem |
| Paragraf | 1rem → 1.125rem |

Ukuran persisnya bisa dikonfirmasi kalau file `.css`-nya ikut diupload. Simpan dengan Ctrl+S sebagai "Webpage, Complete", lalu kirim folder `_files`-nya.

---

## 4. Spacing, layout & breakpoint [Terukur]

- **Skala spacing (rem):**

  | Token | Nilai |
  |---|---|
  | 1–9 | 0.25 · 0.5 · 0.75 · 1 · 1.25 · 1.5 · 1.75 · 2 · 2.25 |
  | 10–15 | 2.5 · 3 · 3.5 · 4 · 4.5 · 5 |
  | 16–20 | 7.5 · 10 · 12.5 · 15 · 20 |

- **Padding vertikal section:** naik bertahap dari `space-12` 3.5rem (mobile) ke `space-14` 4.5rem, lalu `space-16` 7.5rem (desktop). Section gelap memakai 7.5rem.
- **Lebar konten:** container lebar maks **85rem**. Teks judul maks 70rem, teks/kutipan maks 52rem. Hero dan judul section rata tengah.
- **Breakpoint:** 448 · 640 · **768** · 980 · **1024** · 1200 · **1440** px, pendekatan mobile-first (`min-width`). Yang paling sering dipakai 1024, 768, dan 1440.
- **Grid:** poin "Why Bitwise" dan kartu Insights masing-masing 3 kolom di desktop, 1 kolom di mobile.

---

## 5. Bentuk, border, shadow & motion [Terukur]

- **Radius:**
  - **0.25rem (4px)** untuk tombol, input, kartu, dan badge. Ini yang dominan.
  - 0.5rem dan 1rem untuk kontainer besar.
  - 2rem untuk elemen dekoratif.
  - Penuh (100% / 9999px) untuk ikon bulat dan pill.
- **Border:** 1px, warna slate4 `#ebedef` secara default. Input memakai slate6, slate8 saat hover, dan slate10 saat fokus. Fokus ditandai warna border, bukan glow berwarna.
- **Shadow:** berlapis 4 tingkat dengan opacity rendah, sehingga terlihat lembut seperti mengambang.
  - `card`: `0 16px 16px rgba(17,24,28,.05), 0 8px 8px rgba(17,24,28,.05), 0 4px 4px rgba(17,24,28,.05), 0 2px 2px rgba(17,24,28,.05)`
  - `menu` / `select`: lapisan serupa dengan `rgba(0,0,0,.05)` ditambah ring 1px.
- **Efek kaca:** `backdrop-filter: blur(12px)` dengan `rgba(22,26,27,.72)`, untuk kartu/kutipan di atas gambar gelap.
- **Transisi:** short 300ms, base 500ms, long 700ms, semuanya `ease-in-out`. Hover terasa pelan dan halus.

---

## 6. Komponen

### Tombol [Terukur]
- **Dasar:**
  - `inline-flex`, Neue Montreal 550, **UPPERCASE**, letter-spacing 0.05rem, ukuran **12px**.
  - Radius 4px, transisi 300ms pada warna, latar, dan border.
- **Ukuran:**
  - `sm`: tinggi 2.5rem, padding 0.5rem 1rem.
  - `md`: tinggi **3rem**, padding 0.5rem 1.5rem, lebar minimal 7.5rem.
- **Varian:**

  | Varian | Normal | Hover |
  |---|---|---|
  | **Primary** | latar `#22c96a`, teks putih, tanpa border | latar `#0da54f` |
  | **Secondary** | teks dan border 1px `#22c96a`, latar transparan | latar `#22c96a`, teks putih |
  | **Tertiary** | teks dan border 1px slate15 `#11181c`, transparan | teks dan border slate11 `#697177` |

  Contoh di hero: "Learn More" memakai tertiary, "Start Investing" memakai primary.

### Pill / badge [Terukur]
- **Badge pengumuman** (contoh: "Get the Weekly CIO Memo"):
  - Latar slateA3, border 1px slate9, radius 4px, padding 0.125rem 1rem.
  - Neue Montreal 550, teks slate15.
- **Tag filter / kategori:**
  - Border 1px slate5, transparan, teks slate11.
  - 0.75rem uppercase, letter-spacing 0.08em, padding 0.625rem 0.875rem.

### Kartu [Terukur]
- Latar slate2 `#f9fafb`, border 1px slate5, radius 4px, overflow hidden.
- Transisi 500ms. Saat hover, border/shadow menguat.
- **Kartu artikel:**
  - Label kategori + tanggal ("Research • Oct 7, 2026") dengan gaya eyebrow.
  - Judul memakai H5 sans 550.
  - Ringkasan memakai teks slate12.
  - Link "Read More" uppercase.

### Input / select [Terukur]
- Tinggi 2.5rem, latar putih, border 1px slate4/slate6, radius 4px, teks slate15 Neue Montreal 550.
- Border slate8 saat hover dan slate10 saat fokus.

### Navigasi
- **Utility bar** **[Terukur]:**
  - Latar slate2, border slate6, hover slate4.
  - Link kecil (Investor Portal, Expert Portal).
- **Nav utama:** latar putih, logo slate15, link slate15.
- **Dropdown "Expert Portal":** panel dengan `shadows-menu`, deskripsi singkat, tombol "Create Account" dan "Log In".

### Section gelap / footer [Terukur]
- Latar slate15 `#11181c`, padding 7.5rem, tinggi minimal 40rem untuk section hero gelap. Konten di tengah.
- Teks putih dan abu, aksen hijau cerah.
- Footer memuat alamat kantor (San Francisco, New York, London, Frankfurt) dan disclaimer kecil 0.75rem.

---

## 7. Aturan ringkas (do & don't)

**Do**
- Judul serif tipis dan lebar, dengan 1–2 kata kunci *italic*.
- Eyebrow uppercase dengan spasi lebar di atas setiap judul section.
- Banyak ruang kosong. Section dipisah oleh perubahan latar (putih → slate2 → slate15), bukan oleh garis tebal.
- Satu tombol primary hijau per area. Aksi kedua pakai tombol tertiary outline gelap.
- Sudut tegas 4px dan shadow berlapis yang sangat halus.
- Animasi lambat (300–700ms) dan tenang.

**Don't**
- Jangan pakai gradien warna-warni, neon, atau glow. Situs ini sangat datar dan bersih.
- Jangan pakai hijau untuk latar besar atau teks panjang.
- Jangan pakai radius besar (pill) untuk tombol.
- Jangan pakai bold berat untuk judul. Judul memakai serif 350, bukan 700.
- Jangan pakai hitam murni `#000` untuk teks. Pakai slate15 `#11181c`.

---

## 8. Catatan untuk Overflow Trade (rencana, belum diterapkan)

- Aplikasi trading butuh **dark mode**. Usulan turunannya:

  | Peran | Warna |
  |---|---|
  | Latar | slate16 `#020304` / slate15 `#11181c` |
  | Kartu | slate14 `#1c262c` |
  | Permukaan | slate13 `#252d31` |
  | Border | `#2b353b` |
  | Teks | putih / slate8 |
  | Aksen | brand400 `#39db7f` |

- **Candle dan profit/loss:** green9 `#30a46c` / red9 `#e5484d` (light), green dan red yang lebih terang untuk dark. Brand hijau tetap terpisah untuk tombol.
- **Font:** butuh keputusan antara membeli lisensi Items + Neue Montreal atau memakai pengganti gratis (Fraunces/Instrument Serif + Inter/Instrument Sans).
- Sesuai permintaan, **website belum diubah.** Dokumen ini hanya panduan.
