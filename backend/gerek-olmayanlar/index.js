//sunucuyu baslatalim


//node-cron ile her saat başı tetiklenir,

//node-fetch ile bir haber sitesine gidilir,

//cheerio ile o sitedeki başlıklar ayıklanır,

//dotenv ile veri tabanı şifreleri korunur,

//express ile de çekilen bu veriler bir web sayfasında gösterilir.

import "dotenv/config";
import express from "express";
import cron from "node-cron";
import puppeteer from "puppeteer";
import crypto from "node:crypto";


import { checkZaraStock } from "../zaraChecker.js";      // <-- yeni checker (puppeteer + senin sku mantığın)
import { sendTelegramMessage } from "../notifier.js";     // <-- sende notifier.js var dedin (aşağıdaki fonksiyon ismiyle eşleştir)
import { loadTracked, saveTracked } from "../store.js";   // <-- yeni (json'da takip listesi)

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ✅ Çoklu takip listesi (JSON’dan yükle)
let trackedProducts = loadTracked();

// ✅ Tek browser instance: performans + daha az blok riski

const browser = await puppeteer.launch({
  headless: "new",
  defaultViewport: { width: 1365, height: 768 },
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ],
});

app.get("/", (req, res) => res.send("OK"));

app.get("/list", (req, res) => {
  res.json(trackedProducts);
});

app.get("/run-now", async (req, res) => {
  try {
    const now = Date.now();
    const items = trackedProducts.filter((x) => {
      if (x.notified) return false;
      if (x.cooldownUntil && now < x.cooldownUntil) return false;
      return true;
    });

    console.log(`\n🟣 RUN-NOW tetiklendi. Takip edilen: ${items.length}`);

    for (const item of items) {
      console.log("🔎 Kontrol:", item.size, item.url);

      const r = await checkZaraStock({
        browser,
        url: item.url,
        targetSize: item.size,
      });

      if (!r.ok) {
        console.log("⚠️ Skip/Fail:", r.reason);
        continue;
      }

      console.log("✅ RUN-NOW sonuç:", r);
    }

    res.json({ ok: true, count: items.length });
  } catch (e) {
    console.log("❌ RUN-NOW hata:", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});


app.get("/test-telegram", async (req, res) => {
  try {
    await sendTelegramMessage("✅ Telegram test mesajı (zara stock watcher)");
    res.json({ ok: true, message: "Telegram mesajı gönderildi" });
  } catch (e) {
    console.log("❌ Telegram test hatası:", e?.message);
    res.status(500).json({ ok: false, error: e?.message });
  }
});


// ✅ ürün takibe alma (çoklu)
app.post("/track", (req, res) => {
  const { url, size } = req.body || {};
  if (!url || !size) return res.status(400).json({ error: "url ve size zorunlu" });

  const item = {
    id: crypto.randomUUID(),
    url,
    size: String(size).toUpperCase(),
    notified: false,
    createdAt: new Date().toISOString(),
  };

  trackedProducts.push(item);
  saveTracked(trackedProducts);

  console.log("Takibe Alındı:", item);
  res.json({ ok: true, item });
});

// ✅ takipten çıkar
app.delete("/track/:id", (req, res) => {
  const { id } = req.params;
  trackedProducts = trackedProducts.filter((x) => x.id !== id);
  saveTracked(trackedProducts);
  res.json({ ok: true });
});


let isRunning = false;

// ✅ Her 5 dakikada bir kontrol (senin mevcut cron mantığın)
cron.schedule("*/5 * * * *", async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    const now = Date.now();
    const items = trackedProducts.filter((x) => {
      if (x.notified) return false;
      if (x.cooldownUntil && now < x.cooldownUntil) return false;
      return true;
    });

    if (!items.length) return;

    console.log(`\n🕒 Kontrol başlıyor. Takip edilen: ${items.length}`);

    for (const item of items) {
      try {
        console.log("🔎 Kontrol:", item.size, item.url);

        const r = await checkZaraStock({
          browser,
          url: item.url,
          targetSize: item.size,
        });

        if (!r.ok) {
          console.log("⚠️ Skip/Fail:", r.reason);

          if (r.reason === "ACCESS_DENIED") {
          // ürünü 1 saat farkla tekrar dene (spam olmasın)
            item.cooldownUntil = Date.now() + 60 * 60 * 1000;
            saveTracked(trackedProducts);

            try{
              await sendTelegramMessage(
                            `⛔ Zara Access Denied (bot koruması).\n1 saat boyunca bu ürünü kontrol etmeyeceğim.\n${item.url}`
                          );
            }catch(e) {
              console.log("❌ Telegram gönderilemedi:", e?.message);
            }
          }
          continue;
        }

        if (r.inStock) {
          const msg =
            `🎉 STOK GELDİ!\n` +
            `Beden: ${item.size}\n` +
            `Durum: ${r.status}\n` +
            `SKU: ${r.sku}\n` +
            `${item.url}`;

          await sendTelegramMessage(msg);

          item.notified = true;
          item.notifiedAt = new Date().toISOString();
          saveTracked(trackedProducts);

          console.log("✅ Bildirim gönderildi:", item.id);
        } else {
          console.log("❌ Stok yok:", item.size, r.status || r.detail || "");
        }
      } catch (e) {
        console.log("❌ Kontrol hatası:", e?.message);
      }
    }
  } finally {
    isRunning = false;
  }
});


app.listen(PORT, () => {
  console.log(`Backend çalışıyor -> http://localhost:${PORT}`);
  // server açılınca 1 kez hemen kontrol
  (async () => {
    const now = Date.now();
    const items = trackedProducts.filter((x) => {
      if (x.notified) return false;
      if (x.cooldownUntil && now < x.cooldownUntil) return false;
      return true;
    });

    if (items.length) {
      console.log("🚀 İlk kontrol tetiklendi");
    }
  })();

});

process.on("SIGINT", async () => {
  console.log("🛑 Kapatılıyor...");
  await browser.close();
  process.exit(0);
});


