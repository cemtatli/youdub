<p align="center">
  <img src="icons/logo.svg" width="112" alt="youdub logosu">
</p>

<h1 align="center">youdub</h1>

<p align="center">
  YouTube'u Türkçe izle. Videoları kendi bilgisayarında Türkçe seslendiren bir Chrome eklentisi.<br>
  Bulut yok, API anahtarı yok.
</p>

<p align="center"><a href="README.md">English</a> · <b>Türkçe</b></p>

## Özellikler

- **Türkçe seslendirme**: oynatıcıda **TR**'ye bas, video Türkçe konuşsun. Orijinal ses kısılır, müzik kalır.
- **Yerel çeviri**: İngilizce videolar senin bilgisayarında çevrilir. Diğer dillerde YouTube'un Türkçe altyazısı kullanılır. Shift+tık **TR** ile ikisi arasında geçiş yapılır.
- **Senkron kalır**: durdurma, ileri sarma ve hız değişikliğini takip eder. Uzun cümleler biraz hızlı okunur, gerekirse video hafifçe yavaşlar.
- **İngilizce kelimeler doğru okunur**: "feedback" harf harf değil, "fidbek" diye söylenir.
- **Türkçe altyazı**: dünya butonu, Türkçe altyazıyı Netflix tarzı cümle cümle gösterir. Yukarı aşağı sürüklenebilir, çift tıkla eski yerine döner.
- **Daha sonra izle**: videonun altındaki butonla tek tıkla ekle ya da çıkar.
- **Minimal mod**: önerileri gizler, sadece video (ve bölümler) kalır.
- **Reklamlar**: reklam sırasında sessiz kalır.

## Kurulum

1. Bir kez çalıştır:
   ```sh
   ./install.sh
   ```
   Yerel sesi ve modelleri (~320 MB) kurar. Chrome, Brave, Chromium ve Helium'a tanıtır.
2. `chrome://extensions` aç, **Geliştirici modu**'nu aç, **Paketlenmemiş öğe yükle** ile bu klasörü seç.
3. Bir YouTube videosu aç ve **TR**'ye bas.

Yerel ses açılamazsa youdub tarayıcının Türkçe sesine geçer.

## Modeller

Hepsi işlemcinde çalışır. Hiçbir şey bilgisayarından çıkmaz.

| Görev | Model | Boyut | Lisans |
| --- | --- | --- | --- |
| Ses | [EMA Lightning](https://huggingface.co/canberkkkkkk/ema-lightning) | ~34 MB | Apache 2.0 |
| Çeviri (EN → TR) | [OPUS-MT tc-big en-tr](https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-en-tr), int8 | ~230 MB | CC-BY-4.0 |
| Noktalama (İngilizce otomatik altyazı) | [punct_cap_seg_en](https://huggingface.co/1-800-BAD-CODE/punct_cap_seg_en), int8 | ~53 MB | Apache 2.0 |

**TR** açıkken ~730 MB RAM kullanır. Çeviri ayrı, düşük öncelikli bir süreçte çalışır ve son istekten 20 sn sonra kapanır.

## Hata ayıklama

- Sayfa konsolu: `__youdub.state`, `__youdub.setOn(true)`. Loglar `[youdub]` önekiyle gelir.
- Ses logları: `chrome://extensions` → youdub → service worker.
- Sesi elle başlatmak için: `server/run.sh`.

## Bilinen sınırlar

- Yerel çeviri yalnızca İngilizce için var ve cümle cümle çalışır, bağlamı kaçırabilir.
- Altyazısı olmayan videolar seslendirilmez.
- Otomatik tarayıcılara YouTube boş altyazı verir. Normal bir Chrome profilinde test et.

## Teşekkürler

Altyazı yaklaşımı: [voice-over-translation](https://github.com/ilyhalight/voice-over-translation) (MIT).
Font: Vercel'in [Geist](https://vercel.com/font) fontu (SIL OFL 1.1).
Telaffuzlar: [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict) (BSD).
Kelime frekansları: [FrequencyWords](https://github.com/hermitdave/FrequencyWords) (MIT kod, CC-BY-SA-4.0 veri).
