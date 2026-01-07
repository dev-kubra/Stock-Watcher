import puppeteer from "puppeteer";

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
  return await page.evaluate(() => {
    const targets = new Set([
      "EKLE",
      "SEPETE EKLE",
      "ADD",
      "ADD TO BAG",
      "ADD TO CART",
    ]);

    const btns = Array.from(document.querySelectorAll("button"));

    const visible = (b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const btn = btns.find((b) => {
      const t = (b.innerText || "").trim().toUpperCase();
      return visible(b) && targets.has(t);
    });

    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
}

async function readSizesFromPanel(page) {
  return await page.evaluate(() => {
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
          li.querySelector("[data-qa-qualifier*='size-label']") ||
          li.querySelector("span");

        const size = (labelEl?.textContent || "").trim();
        if (!size) return null;

        const className = li.className || "";
        const isDisabledClass = className.includes("size-selector-sizes__size--disabled");

        const btn = li.querySelector("button");
        const qaAction = btn?.getAttribute("data-qa-action") || "";

        const isOut = qaAction === "size-out-of-stock";
        const disabled = isDisabledClass || isOut;

        return { size, disabled, qaAction, rawClass: className };
      })
      .filter(Boolean);
  });
}

/**
 * ✅ TEK HEDEF: puppeteer-test’i fonksiyon yapmak
 * Kullanım:
 *   const r = await checkStock({ url, size: "M", headless: false })
 */
export async function checkStock({ url, size, headless = false, keepOpen = false }) 
{
  const PRODUCT_URL = url;
  const TARGET_SIZE = String(size || "").toUpperCase();

  const browser = await puppeteer.launch({ headless, defaultViewport: null });

  try {
    const page = await browser.newPage();

    const wantedProductId = getV1ProductId(PRODUCT_URL);
    // console.log("🎯 Beklenen v1 productId:", wantedProductId);

    let availabilityMap = {};
    let availabilityReady = false;

    page.on("response", async (res) => {
      const rurl = res.url();
      if (!rurl.includes("/availability")) return;

      // sadece seçili v1 productId
      if (wantedProductId && !rurl.includes(`/product/id/${wantedProductId}/availability`)) return;

      try {
        const data = await res.json();
        if (!Array.isArray(data?.skusAvailability)) return;

        availabilityMap = {};
        for (const s of data.skusAvailability) availabilityMap[String(s.sku)] = s.availability;
        availabilityReady = true;
      } catch {}
    });

    await page.goto(PRODUCT_URL, { waitUntil: "domcontentloaded", timeout: 0 });
    await sleep(1500);

    const addOk = await clickAdd(page);
    if (!addOk) {
      return { ok: false, reason: "EKLE butonu bulunamadı" };
    }

    // panelin gerçekten geldiğinden emin olalım
    const panelOk = await page
      .waitForSelector("ul.size-selector-sizes, ul[class*='size-selector-sizes'], [class*='size-selector'] ul", { timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (!panelOk) {
      return { ok: false, reason: "Panel açılmadı" };
    }


    let domSizes = [];
    for (let i = 0; i < 3; i++) {
      domSizes = await readSizesFromPanel(page);
      if (domSizes.length) break;
      await sleep(800);
    }

    if (!domSizes.length) {
      return { ok: false, reason: "Panelden beden okunamadı" };
    }

    const orderedDomSizes = domSizes
      .map((x) => x.size)
      .filter((s) => SIZE_ORDER.includes(s))
      .sort((a, b) => SIZE_ORDER.indexOf(a) - SIZE_ORDER.indexOf(b));

    for (let i = 0; i < 6 && !availabilityReady; i++) await sleep(800);
    if (!availabilityReady) {
      return { ok: false, reason: "availability gelmedi" };
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
    orderedDomSizes.forEach((s, i) => (sizeSkuMap[s] = sortedSkus[i]));

    if (!(TARGET_SIZE in sizeSkuMap)) {
      return { ok: true, inStock: false, detail: `${TARGET_SIZE} bu üründe yok`, sizeSkuMap };
    }

    const sku = sizeSkuMap[TARGET_SIZE];
    const status = availabilityMap[String(sku)];
    const inStock = AVAILABLE_STATUSES.has(status);

    return { ok: true, inStock, status, sku, sizeSkuMap };
  } catch (e) {
    return { ok: false, reason: e?.message || "unknown_error" };
  } finally {
    if (keepOpen) {
      await new Promise(() => {}); // açık kalsın
    }
    await browser.close();
  }
}

