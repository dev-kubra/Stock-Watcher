const AVAILABLE_STATUSES = new Set(["in_stock", "low_on_stock"]);
const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getV1ProductId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("v1");
  } catch {
    return null;
  }
}

function firstSix(n) {
  const s = String(n);
  return s.length >= 6 ? s.slice(0, 6) : null;
}

async function clickAdd(page) {
  // 1) Selector ile dene
  const selectors = [
    'button[data-qa-action="add-to-cart"]',
    'button[data-qa-action="add-to-bag"]',
    'button[data-qa-action="add-to-cart-button"]',
    'button[data-qa-action="product-detail-add-to-cart"]',
    'button[data-testid*="add"]',
    'button[class*="add-to-cart"]',
    'button[class*="add-to-bag"]',
    'button[class*="product-detail"]',
  ];

  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click();
      return true;
    }
  }

  // 2) Metne göre dene
  return await page.evaluate(() => {
    const texts = new Set(["EKLE", "SEPETE EKLE", "ADD", "ADD TO BAG", "ADD TO CART"]);
    const btns = Array.from(document.querySelectorAll("button"));

    const visible = (b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const btn = btns.find((b) => {
      const t = (b.innerText || "").trim().toUpperCase();
      return visible(b) && texts.has(t);
    });

    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
}

async function readSizesFromPanel(page) {
  // Panelin açılmasını bekle (Zara farklı container kullanabiliyor)
  const panelSelectors = [
    "ul.size-selector-sizes",
    "ul[class*='size-selector-sizes']",
    "[class*='size-selector'] ul",
    ".size-selector",
  ];

  let panelFound = false;
  for (const sel of panelSelectors) {
    const ok = await page
      .waitForSelector(sel, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      panelFound = true;
      break;
    }
  }
  if (!panelFound) return { sizes: [], debug: { reason: "panel selector bulunamadı" } };

  // 1) li üzerinden oku
  try {
    const sizes = await page.$$eval("ul.size-selector-sizes li, ul[class*='size-selector-sizes'] li", (lis) => {
      const out = [];
      for (const li of lis) {
        const btn = li.querySelector("button");
        const size = (btn?.innerText || li.innerText || "").trim();
        if (!size) continue;

        const rawClass = li.className || "";
        const qaAction = btn?.getAttribute("data-qa-action") || "";
        const disabled =
          rawClass.includes("size-selector-sizes__size--disabled") ||
          qaAction === "size-out-of-stock" ||
          btn?.disabled === true;

        out.push({ size, disabled, qaAction, rawClass });
      }
      return out;
    });

    if (Array.isArray(sizes) && sizes.length) return { sizes, debug: null };
  } catch {}

  // 2) button[data-qa-action^="size-"] üzerinden oku
  try {
    const sizes = await page.$$eval('button[data-qa-action^="size-"]', (btns) => {
      const out = [];
      for (const btn of btns) {
        const size = (btn.innerText || "").trim();
        if (!size) continue;

        const qaAction = btn.getAttribute("data-qa-action") || "";
        const li = btn.closest("li");
        const rawClass = li?.className || btn.className || "";
        const disabled =
          rawClass.includes("size-selector-sizes__size--disabled") ||
          qaAction === "size-out-of-stock" ||
          btn.disabled === true;

        out.push({ size, disabled, qaAction, rawClass });
      }
      return out;
    });

    if (Array.isArray(sizes) && sizes.length) return { sizes, debug: null };
  } catch {}

  // Debug: panel HTML'den küçük bir parça alalım
  const htmlSnippet = await page.evaluate(() => {
    const el =
      document.querySelector("ul.size-selector-sizes") ||
      document.querySelector("ul[class*='size-selector-sizes']") ||
      document.querySelector("[class*='size-selector'] ul") ||
      document.querySelector(".size-selector");

    if (!el) return null;
    return (el.outerHTML || "").slice(0, 1200);
  });

  return { sizes: [], debug: { reason: "panel bulundu ama size okunamadı", htmlSnippet } };
}

export async function checkZaraStock({ browser, url, targetSize }) {
  const wantedProductId = getV1ProductId(url);

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
  });

  let availabilityMap = {};
  let availabilityReady = false;

  page.on("response", async (res) => {
    const rurl = res.url();
    if (!rurl.includes("/availability")) return;

    if (wantedProductId && !rurl.includes(`/product/id/${wantedProductId}/availability`)) return;

    try {
      const data = await res.json();
      if (!Array.isArray(data?.skusAvailability)) return;

      availabilityMap = {};
      for (const s of data.skusAvailability) availabilityMap[String(s.sku)] = s.availability;
      availabilityReady = true;
    } catch {}
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 0 });
    await sleep(1500);

    const addOk = await clickAdd(page);
    if (!addOk) {
      const debug = await page.evaluate(() => {
        const title = document.title;
        const href = location.href;

        const htmlText = document.documentElement.innerText || "";
        const flags = {
          hasVerify: /verify|interstitial|access denied|robot|captcha/i.test(htmlText),
          hasCookie: /cookie|çerez/i.test(htmlText),
        };

        return { title, href, flags };
      });

      console.log("🧪 DEBUG (EKLE bulunamadı):", JSON.stringify(debug, null, 2));

      if (debug?.title?.toLowerCase().includes("access denied") || debug?.flags?.hasVerify) {
        return { ok: false, reason: "ACCESS_DENIED" };
      }
      return { ok: false, reason: "EKLE butonu bulunamadı" };
    }

    await sleep(1200);

    // Panel bedenlerini oku (3 deneme)
    let panelResult = { sizes: [], debug: null };
    for (let i = 0; i < 3; i++) {
      panelResult = await readSizesFromPanel(page);
      if (panelResult.sizes.length) break;
      await sleep(800);
    }

    if (!panelResult.sizes.length) {
      console.log("🧪 PANEL DEBUG:", JSON.stringify(panelResult.debug, null, 2));
      return { ok: false, reason: "Panelden beden okunamadı" };
    }

    console.log("👀 PANEL BEDENLER:", panelResult.sizes);

    const orderedDomSizes = panelResult.sizes
      .map((x) => x.size)
      .map((s) => s.toUpperCase())
      .filter((s) => SIZE_ORDER.includes(s))
      .sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));

    if (!orderedDomSizes.length) {
      return { ok: false, reason: "Panelde beklenen beden isimleri yok" };
    }

    // availability bekle
    for (let i = 0; i < 6 && !availabilityReady; i++) await sleep(800);
    if (!availabilityReady) {
      return { ok: false, reason: "Availability gelmedi" };
    }

    const sortedSkus = Object.keys(availabilityMap).map(Number).sort((a, b) => a - b);

    if (sortedSkus.length !== orderedDomSizes.length) {
      return { ok: false, reason: "SKU sayısı ≠ beden sayısı" };
    }

    const prefixes = new Set(sortedSkus.map(firstSix));
    if (prefixes.size !== 1) {
      return { ok: false, reason: "SKU ilk 6 hane aynı değil" };
    }

    const sizeSkuMap = {};
    orderedDomSizes.forEach((size, i) => (sizeSkuMap[size] = sortedSkus[i]));

    const target = String(targetSize).toUpperCase();
    if (!(target in sizeSkuMap)) {
      return { ok: true, inStock: false, detail: `${target} bu üründe yok`, sizeSkuMap, availabilityMap };
    }

    const sku = sizeSkuMap[target];
    const status = availabilityMap[String(sku)];
    const inStock = AVAILABLE_STATUSES.has(status);

    return { ok: true, inStock, sku, status, sizeSkuMap, availabilityMap };
  } finally {
    await page.close();
  }
}
