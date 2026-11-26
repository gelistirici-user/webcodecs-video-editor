# Kurgu Studio

Premiere Pro ve DaVinci Resolve'dan esinlenen, **hafif ve kolay kullanılan** bir masaüstü video editörü.
Electron + saf JavaScript (çerçeve yok, derleme adımı yok) ile yazıldı; kodlama donanım hızlandırmalı **WebCodecs** ile yapılır, bu yüzden FFmpeg kurmanız gerekmez.

## Özellikler

**Kurgu (Edit) sayfası**
- Çok izli zaman çizelgesi (video + ses izleri, iz ekle/sil, gizle, sessize al, solo, kilitle)
- Bağlantılı video/ses klipleri (Alt ile tek tarafı düzenle, bağlantıyı kopar/bağla)
- Seçim ve **Jilet** araçları, yakalama (snapping), seçim kutusu, Alt+sürükle ile kopyalama
- Kırpma, üzerine yazma / ekleme (Ctrl+bırak), dalgalı silme, boşluk kapatma, **Q/W dalgalı kırpma**
- Kaynak monitör: giriş/çıkış (I/O) işaretleyip `,` ile ekle, `.` ile üzerine yaz
- Program monitörde klibi doğrudan sürükle / ölçekle / Alt ile döndür
- Fade tutamaçları (klibin üst köşelerinden), hız/süre (%10–%800), işaretçiler, giriş/çıkış aralığı
- Geçişler: çapraz geçiş, siyaha/beyaza geçiş, silme, kaydırma, itme, yakınlaşma, daire açılım
- Başlık şablonları (alt üçte bir, altyazı, sinematik, daktilo…), metin kontur/gölge/kutu
- Renk ve gradyan üreteçleri, karışım modları, kırpma, çevirme, hazır animasyonlar (Ken Burns vb.)
- Ses ölçerleri (dBFS), klip ses seviyesi (+6 dB'e kadar) ve ses fade'leri
- **Anahtar kare (keyframe)**: konum, ölçek, döndürme, opaklık, renk ayarları, ses seviyesi, maske (◆ denetimleri, yumuşatma seçenekleri)
- **Hız rampası** (hız anahtar kareleri) ve **ters oynatma** (önizleme + çıktı, ses dahil)
- **Maske** (elips/dikdörtgen, yumuşatma, ters), **hareket takibi** (maskeyi izle, başlığa aktar), **görüntü sabitleme**
- **Birden çok sekans** ve **iç içe sekans** (seçimi iç içe sekansa dönüştür, çift tıkla aç)
- **Çok kameralı kurgu**: sese göre otomatik senkron, ızgara görünümü, 1–9 tuşlarıyla açı değiştirme
- **Proxy medya**: ağır videoların hafif kopyalarıyla akıcı önizleme (çıktı orijinalden)

**Renk (Color) sayfası**
- 12 hazır görünüm (Sinematik, Teal & Orange, Vintage, Noir…)
- Parlaklık, kontrast, doygunluk, sıcaklık, ton, renk tonu, vinyet, bulanıklık
- Ölçümler: luma dalga formu, RGB histogram, vektörskop
- GPU renk motoru: **renk çarkları** (gölgeler / orta tonlar / parlak alanlar), **eğriler** (Ana/K/Y/M), **.cube LUT**, **chroma key** (yeşil perde)

**Ses ve otomatik araçlar (Araçlar menüsü)**
- **Gürültü azaltma** (spektral), alçak kesim, konuşmayı netleştirme
- **Normalleştirme** (tepe -1 dB veya ~-14 LUFS), **otomatik ducking** (konuşmada müziği kıs)
- **Sessizlikleri otomatik kes**
- **Otomatik altyazı (Whisper)**: konuşma bilgisayarda yazıya dökülür (Türkçe dahil), SRT dışa/içe aktarma.
  Model ilk kullanımda bir kez indirilir (~80–250 MB) ve saklanır; ses hiçbir sunucuya gönderilmez.

**Teslim (Deliver)**
- MP4 (H.264/H.265 + AAC) veya WebM (VP9 + Opus)
- Sekans / yarım / 720p / 4K çözünürlük, kalite ön ayarları veya özel bit hızı
- Tüm sekans veya giriş–çıkış aralığı; kare kare doğru çıktı ("ne görüyorsan o")
- **Render kuyruğu**: birden çok dışa aktarmayı sıraya al, kurguya devam ederken arka planda işlensin

**Diğer**
- `.kurgu` proje dosyaları (medya kopyalanmaz, yol olarak bağlanır), eksik medyayı yeniden bağlama
- Otomatik yedek ve çökme sonrası kurtarma, 200 adım geri al/yinele
- Boyutlandırılabilir paneller, tam ekran monitör, güvenli alan kılavuzları, PNG kare yakalama

## Kullanım

Hazır paket: `dist/` klasöründeki **KurguStudio-Portable-x.y.z.exe** (kurulumsuz) veya **Kurgu Studio Setup x.y.z.exe** (kurulum).

Geliştirme:

```powershell
npm install
npm start          # uygulamayı çalıştır
npm run serve      # tarayıcıda test (http://localhost:5173)
npm run dist       # Windows paketlerini dist/ altına üret
```

## Klavye kısayolları (özet)

| Tuş | İşlev | Tuş | İşlev |
|---|---|---|---|
| Boşluk | Oynat/duraklat | J / K / L | Geri / dur / ileri |
| ← / → | Kare adımı (Shift: 1 sn) | ↑ / ↓ | Önceki/sonraki kesme |
| I / O | Giriş / çıkış | V / C | Seçim / jilet |
| Ctrl+K | Böl | Q / W | Dalgalı kırp |
| Delete / Shift+Delete | Sil / dalgalı sil | M | İşaretçi |
| Ctrl+Z / Ctrl+Shift+Z | Geri al / yinele | Ctrl+M | Dışa aktar |
| Alt+1/2/3 | Kurgu / Renk / Teslim | ? | Tüm kısayollar |
| 1–9 (Çok Kamera sekmesi) | Açı değiştir | ◆ (denetçi) | Anahtar kare ekle/kaldır |

## Yapı

```
main.js            Electron ana süreç (pencere, dosya diyalogları, media:// ve app:// protokolleri)
preload.js         Güvenli köprü (contextIsolation)
src/js/store.js    Proje modeli, geri al/yinele, kurgu işlemleri
src/js/compositor.js  Kare birleştirici (önizleme ve dışa aktarma aynı kodu kullanır)
src/js/player.js   Oynatma motoru, ses yönlendirme ve ölçerler
src/js/timeline.js Zaman çizelgesi çizimi ve etkileşimleri
src/js/inspector.js Denetçi paneli
src/js/exporter.js WebCodecs + mediabunny ile MP4/WebM çıktı
src/js/app.js      Uygulama kabuğu, menüler, kısayollar
src/js/keyframes.js  Anahtar kare değerlendirme      src/js/timemap.js  Hız rampası / ters eşleme
src/js/fxgl.js     WebGL2 renk motoru (çarklar, eğriler, LUT, chroma key)
src/js/audiofx.js  Ses efektleri, normalleştirme, ducking (worklets/denoise.js: gürültü azaltma)
src/js/analysis.js Sabitleme ve hareket takibi    src/js/subtitles.js  Whisper altyazı (workers/asr.js)
src/js/sequences.js, multicam.js, proxy.js, queue.js  Sekanslar, çok kamera, proxy, render kuyruğu
```

Not: `src/vendor/` altındaki büyük dosyalar (transformers.js, ONNX wasm) depoda tutulmaz; `npm start`, `npm run serve` ve `npm run dist` öncesinde `scripts/vendor.js` ile kopyalanır.

Desteklenen girişler: Chromium'un çözebildiği biçimler (MP4/MOV H.264, H.265*, VP8/VP9/AV1 WebM/MKV, MP3/WAV/AAC/OGG/FLAC, PNG/JPG/WebP/GIF). *H.265 donanım desteğine bağlıdır.

Lisans: MIT. Kapsayıcı kütüphanesi [mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0), konuşma tanıma [transformers.js](https://github.com/huggingface/transformers.js) (Apache-2.0) + Whisper modelleri (MIT).
