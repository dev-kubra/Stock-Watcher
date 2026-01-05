//zara stok kontrol mantigi

import fetch from "node-fetch";
import * as cheerio from "cheerio";

import { sendTelegramMessage } from "./notifier.js";

export async function checkStock({ url, size}) {
  try{
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const html = await res.text();
    const $ = cheerio.load(html);

    let isInStock = false;

    //zara dom yapisi zamanla degisebilir

    $(".size-selector__size").each((_, el) => {
      const txt = $(el).text().trim();
      const disabled = $(el).hasClass("size-selector__size--disabled");

      if(text === size && !disabled) {
        isInStock = true;
      }
    });

    if(isInStock) {
      await sendTelegramMessage(
        `🎉 STOK GELDİ!\nBeden: ${size}\n${url}`
      );
    }
    else {
      console.log('❌ Stok yok: ${size}');
    }
    
  }
  catch(error) {
    console.error("Stok kontrol hatası:", error.message);
  }
}