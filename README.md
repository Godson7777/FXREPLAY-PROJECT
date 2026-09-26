# ReplayLab — Market Replay & Backtesting

Platform *market replay* dan *manual backtesting* ala FX Replay yang kamu host sendiri. Kamu bisa replay chart bar-per-bar dengan data masa depan tersembunyi, trading dengan order engine sungguhan, lalu membedah performa lewat analytics yang dalam.

Semua berjalan **100% di browser**: data dan session disimpan di IndexedDB, jadi tidak perlu server atau database.

![Replay](docs/replay.png)

## Fitur

### Replay
- **Timeframe tanpa batas.** Ketik timeframe apa saja: `1m 3m 7m 13m 45m 90m 2H 3H 6H 8H 12H D 2D 3D W 2W M 3M`, bahkan `45s` kalau datamu per detik. Semua candle diagregasi dari data dasar (1 menit).
- **Candle yang sedang terbentuk.** Di chart 4H, candle yang belum close tumbuh menit demi menit, persis seperti live.
- **Multi-chart:** layout 1/2/3/4 chart. Tiap pane punya symbol dan timeframe sendiri, dan semuanya tersinkron ke jam replay yang sama.
- **Multi-symbol:** satu session bisa berisi beberapa pair (EURUSD + GBPUSD + XAUUSD…), semuanya tersinkron waktu.
- **Kontrol replay:** Play/Pause, next candle, next tick 1m, kecepatan 0.5–100×/detik, lompat +1H/+4H/+1D, lompat ke London/NY open, lompat ke tanggal tertentu. Kamu hanya bisa maju, jadi tidak bisa mengintip hasilnya.
- **Timezone chart:** UTC, Jakarta, New York (DST otomatis), London, dll. Candle harian ikut timezone.

### Trading engine
- Order Market / Limit / Stop dengan SL & TP.
- **Eksekusi di resolusi 1 menit** di timeframe apa pun. SL/TP/pending order dicek setiap bar 1m, termasuk saat price gap.
- Opsi konservatif: kalau SL dan TP tersentuh di bar yang sama, SL dianggap kena duluan.
- Position sizing: Risk %, Risk $, atau Lots; TP dalam R atau pips.
- Trailing stop, auto-breakeven di X R, partial close (½), reverse, BE satu klik, close all.
- **Drag garis SL/TP/entry langsung di chart**, atau edit angkanya di tabel posisi.
- Spread dan komisi per lot. Konversi P&L untuk pair USD-quote, USD-base (USDJPY), emas, dan crypto.
- **MAE/MFE** dicatat untuk setiap trade.

### Drawing tools
Trend line, ray, extended line, horizontal line/ray, vertical line, rectangle, Fibonacci retracement, **tool Long/Short position (R:R)** yang bisa langsung dijadikan order sungguhan, measure, text, dan arrow. Tersedia magnet (snap ke OHLC), drag handle, ganti warna, dan hapus. Drawing tersimpan per symbol, jadi terlihat di semua timeframe.

### Indikator
SMA, EMA, Bollinger Bands, VWAP harian, Donchian, RSI, MACD, ATR, Stochastic, Volume. Parameternya bisa diubah per pane.

### Analytics (mendalam)
- KPI: Net P&L, return %, win rate, profit factor, expectancy ($ dan R), max drawdown (%, $, durasi), total R.
- 30+ statistik: payoff ratio, SQN, Sharpe, Sortino, recovery factor, Kelly %, streak, rata-rata holding (winner vs loser), long vs short, avg MAE/MFE, edge ratio, TP/SL hit rate, best/worst day, % hari profit.
- Equity curve (closed balance dan equity termasuk floating) serta drawdown *underwater*.
- Breakdown (P&L / avg R / win rate / jumlah trade) per hari, jam, market session (Asia/London/overlap/NY), symbol, long/short, setup/tag, exit reason, lama holding, order type, bulan, dan rating.
- **Psikologi:** performa setelah win vs setelah loss (deteksi tilt) dan trade ke-N dalam sehari (deteksi overtrading).
- Distribusi R-multiple, scatter MAE vs MFE, MFE vs realised R (profit yang tertinggal), holding time vs hasil.
- Kalender P&L harian dan tabel return bulanan.
- **Simulasi Monte Carlo:** band persentil equity, peluang profit, median/95% drawdown, dan risk of ruin.
- **Jurnal:** screenshot chart otomatis setiap trade ditutup, plus tag, catatan, dan rating bintang. Bisa export CSV.
- Filter: symbol, side, tag, exit reason, rentang tanggal. Tersedia mode gabungan semua session.

![Analytics](docs/analytics.png)

## Menjalankan

```bash
npm install
npm run dev       # http://localhost:5173
npm test          # unit test engine (timeframe, broker, stats, csv)
npm run build     # hasil static di dist/, bisa di-host di mana saja
```

Buka aplikasinya, klik **Load demo data** (EURUSD, GBPUSD, XAUUSD sintetis 1 tahun), lalu **+ New session**.

### Deploy
`dist/` adalah website statis murni, jadi bisa di-deploy ke GitHub Pages, Netlify, Vercel, Cloudflare Pages, atau nginx. Workflow `.github/workflows/deploy.yml` otomatis deploy ke GitHub Pages setiap push ke `main` (aktifkan Pages → Source: GitHub Actions).

## Data historis

| Sumber | Cara |
|---|---|
| **Forex 1m gratis** | histdata.com → ASCII / 1-Minute Bar. Import dengan offset `-5` (EST tanpa DST). |
| **Dukascopy** | Export CSV 1-minute (UTC), bisa lewat `npx dukascopy-node`. |
| **MT4 / MT5** | History Center → Export. Offset = timezone server broker (biasanya +2/+3). |
| **Crypto** | Tombol **Binance** di tab Data, download 1m langsung dari API publik. |

Parser CSV mendeteksi format secara otomatis. Import symbol yang sama berkali-kali akan **menggabungkan** datanya. Pip size, contract size, dan digits bisa diedit per symbol.

## Shortcut keyboard

| Tombol | Aksi |
|---|---|
| `Space` | Play / pause |
| `→` / `Shift+→` | Candle berikutnya / tick 1m berikutnya |
| `Shift+B` / `Shift+S` | Market buy / sell |
| `Shift+C` | Close all |
| ketik `15`, `4h`, `d`… | Ganti timeframe |
| `Alt+T/H/V/R/F/L/S/M` | Trend, H-line, V-line, Rect, Fib, Long, Short, Measure |
| `Alt+1…4` | Layout 1–4 chart |
| `Del` | Hapus drawing terpilih |

## Arsitektur

```
src/
  core/        timeframe.ts (parser + agregasi TF apa pun), tz.ts, indicators.ts, types.ts
  data/        csv.ts, binance.ts, synthetic.ts, store.ts (IndexedDB), sessions.ts
  engine/      broker.ts (order, fill, SL/TP, MAE/MFE), replay.ts (jam replay multi-symbol)
  analytics/   stats.ts (metrik, breakdown, Monte Carlo)
  ui/          workspace, chartpane (Lightweight Charts), drawings (canvas overlay), analytics, charts (SVG)
```

Chart menggunakan [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts) (Apache-2.0).
