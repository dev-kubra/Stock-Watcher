import express from "express";
import { checkStock } from "./puppeteer-test.js";
import fs from "fs";

const DB_PATH = "./tracked.json";
const load = () => {
  try { return JSON.parse(fs.readFileSync(DB_PATH, "utf-8")); }
  catch { return []; }
};
const save = (data) => fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

let tracked = load();


const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));
app.get("/list", (req, res) => {
  res.json(tracked);
});

app.post("/track", (req, res) => {
  const { url, size } = req.body || {};
  if (!url || !size) return res.status(400).json({ ok: false, error: "url ve size zorunlu" });

  const item = {
    id: crypto.randomUUID(),
    url,
    size: String(size).toUpperCase(),
    createdAt: new Date().toISOString(),
    notified: false,
  };

  tracked.push(item);
  save(tracked);

  console.log("📌 Takibe alındı:", item.id);
  res.json({ ok: true, item });
});


app.post("/check", async (req, res) => {
  console.log("✅ /check geldi", req.body); // <-- BUNU EKLE
  const { url, size } = req.body || {};
  if (!url || !size) return res.status(400).json({ ok: false, error: "url ve size zorunlu" });

  const result = await checkStock({ url, size, headless: false, keepOpen: false });

  res.json(result);
});

app.listen(3000, () => {
  console.log("Server -> http://localhost:3000");
  console.log("POST /check hazır");
});
