//sunucuyu baslatalim


//node-cron ile her saat başı tetiklenir,

//node-fetch ile bir haber sitesine gidilir,

//cheerio ile o sitedeki başlıklar ayıklanır,

//dotenv ile veri tabanı şifreleri korunur,

//express ile de çekilen bu veriler bir web sayfasında gösterilir.

import express from "express";
import cron from "node-cron";
import { checkStock } from "./checker.js";


const app = express();
app.use(express.json());

let trackedProduct = null;

//ürün takibe alma
app.post("/track", (req, res) => {
  const { url, size} = req.body;

  trackedProduct = { url, size };
  console.log("Takibe Alındı : ", trackedProduct);

  res.json({ message: "Ürün takibe alındı" });

});

//Her 5 dakikada bir kontrol
cron.schedule("*/5 * * * *", async() => {
  if (!trackedProduct) return;
  await checkStock(trackedProduct);
});

app.listen(3000, () => {
  console.log("Backend çalışıyor -> http://localhost:3000");
});

