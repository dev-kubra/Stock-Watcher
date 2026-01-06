import puppeteer from "puppeteer";

const TARGET_SIZE = "M";
const PRODUCT_URL = "https://www.zara.com/tr/tr/akici-pareo-etek-zw-collection-p09800001.html?v1=493344507&v2=2635747";

const AVAILABLE_STATUSES = new Set(["in_stock", "low_on_stock"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deepFindSku(obj) {
  // JSON içinde sku/skuId arayan basit ama güçlü tarayıcı
  const found = new Set();

  const walk = (x) => {
    if (!x) return;
    if (typeof x !== "object") return;

    if (Array.isArray(x)) {
      for (const i of x) walk(i);
      return;
    }

    for (const [k, v] of Object.entries(x)) {
      const key = k.toLowerCase();
      if ((key === "sku" || key === "skuid" || key === "sku_id") && (typeof v === "number" || typeof v === "string")) {
        const n = Number(v);
        if (!Number.isNaN(n)) found.add(String(n));
      }
      walk(v);
    }
  };

  walk(obj);
  return [...found];
}

async function ensureSizes(page) {
  // scroll + click ile size selector’ı görünür yapıp bedenleri çek
  const read = () =>
    page.evaluate(() => {
      const ul =
        document.querySelector("ul.size-selector-sizes") ||
        document.querySelector("ul[class*='size-selector-sizes']") ||
        document.querySelector("[class*='size-selector'] ul");

      if (!ul) return [];

      const lis = Array.from(ul.querySelectorAll("li"));
      return lis
        .map((li) => {
          const labelEl =
            li.querySelector('[data-qa-qualifier="size-selector-sizes-size-label"]') ||
            li.querySelector("[class*='size-selector-sizes-size-label']") ||
            li.querySelector("[data-qa-qualifier*='size-label']");

          const size = (labelEl?.textContent || "").trim();
          const btn = li.querySelector("button");
          const qaAction = btn?.getAttribute("data-qa-action") || "";

          const className = li.className || "";
          const isDisabled =
            className.includes("size-selector-sizes__size--disabled") ||
            qaAction === "size-out-of-stock" ||
            (li.textContent || "").toLowerCase().includes("benzer ürünler");

          return { size, isDisabled };
        })
        .filter((x) => x.size);
    });

  let sizes = await read();
  if (sizes.length) return sizes;

  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
  await sleep(1200);

  sizes = await read();
  if (sizes.length) return sizes;

  await page.evaluate(() => {
    const el =
      document.querySelector('[data-qa-qualifier*="size-selector"]') ||
      document.querySelector('[class*="size-selector"]') ||
      document.querySelector('button[class*="size-selector"]');
    if (el && el instanceof HTMLElement) el.click();
  });
  await sleep(1500);

  sizes = await read();
  return sizes;
}

async function clickSize(page, size) {
  // TARGET_SIZE butonuna tıkla
  return page.evaluate((target) => {
    const lis = Array.from(document.querySelectorAll("ul.size-selector-sizes li, ul[class*='size-selector'] li"));
    for (const li of lis) {
      const labelEl =
        li.querySelector('[data-qa-qualifier="size-selector-sizes-size-label"]') ||
        li.querySelector("[class*='size-selector-sizes-size-label']") ||
        li.querySelector("[data-qa-qualifier*='size-label']");

      const s = (labelEl?.textContent || "").trim();
      if (s === target) {
        const btn = li.querySelector("button");
        if (btn && btn instanceof HTMLElement) {
          btn.click();
          return true;
        }
      }
    }
    return false;
  }, size);
}

async function run() {
  const browser = await puppeteer.launch({ headless: false, defaultViewport: null });
  const page = await browser.newPage();

  let availabilityMap = {};
  let availabilityReady = false;

  // SKU’yu bulmak için click sonrası response’ları tarayacağız
  let clickedSkuCandidates = [];
  let clickWindowOpen = false;

  page.on("response", async (res) => {
    const url = res.url();

    // availability yakala
    if (url.includes("/availability")) {
      try {
        const data = await res.json();
        if (Array.isArray(data?.skusAvailability)) {
          availabilityMap = {};
          for (const s of data.skusAvailability) availabilityMap[String(s.sku)] = s.availability;
          availabilityReady = true;
          console.log("📦 AVAILABILITY YAKALANDI");
        }
      } catch {}
    }

    // click sonrası kısa pencerede gelen JSON’lardan SKU ara
    if (clickWindowOpen) {
      try {
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("application/json")) return;

        const data = await res.json();
        const skus = deepFindSku(data);
        if (skus.length) {
          clickedSkuCandidates.push(...skus);
          clickedSkuCandidates = [...new Set(clickedSkuCandidates)];
        }
      } catch {}
    }
  });

  await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded", timeout: 0 });
  console.log("✅ Sayfa açıldı");
  await sleep(2000);

  const sizes = await ensureSizes(page);
  console.log("👀 DOM BEDENLER:", sizes);

  const target = sizes.find((x) => x.size === TARGET_SIZE);
  if (!target) {
    console.log(`❌ DOM’da ${TARGET_SIZE} yok. (farklı beden sistemi olabilir)`);
    await new Promise(() => {});
    return;
  }
  if (target.isDisabled) {
    console.log(`⛔️ DOM’a göre ${TARGET_SIZE} stokta değil (disabled/out-of-stock).`);
    await new Promise(() => {});
    return;
  }

  // ✅ Bedene tıkla ve click sonrası SKU yakalamaya çalış
  clickedSkuCandidates = [];
  clickWindowOpen = true;

  const clicked = await clickSize(page, TARGET_SIZE);
  console.log(clicked ? `🖱️ ${TARGET_SIZE} tıklandı` : `⚠️ ${TARGET_SIZE} tıklanamadı`);

  // click sonrası 2.5sn dinle
  await sleep(2500);
  clickWindowOpen = false;

  console.log("🎯 Click sonrası SKU adayları:", clickedSkuCandidates);

  // availability hazır değilse biraz bekle
  for (let i = 0; i < 6 && !availabilityReady; i++) await sleep(1000);

  if (!availabilityReady) {
    console.log("⚠️ availability gelmedi; şimdilik karar veremiyorum.");
    await new Promise(() => {});
    return;
  }

  // SKU adaylarından availability’de olanı seç
  const matched = clickedSkuCandidates.find((sku) => availabilityMap[sku]);
  if (!matched) {
    console.log("⚠️ Click sonrası SKU’yu availability ile eşleştiremedim (endpoint değişmiş olabilir).");
    console.log("availabilityMap keys örnek:", Object.keys(availabilityMap).slice(0, 10));
    await new Promise(() => {});
    return;
  }

  const status = availabilityMap[matched];
  if (AVAILABLE_STATUSES.has(status)) {
    console.log(`🎉🎉🎉 ${TARGET_SIZE} BEDEN STOKTA! (SKU: ${matched}, ${status})`);
  } else {
    console.log(`❌ ${TARGET_SIZE} stokta değil (SKU: ${matched}, ${status})`);
  }

  await new Promise(() => {});
}

run();
