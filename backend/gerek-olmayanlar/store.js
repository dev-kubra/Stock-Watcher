import fs from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "tracked.json");

export function loadTracked() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveTracked(items) {
  fs.writeFileSync(FILE, JSON.stringify(items, null, 2), "utf-8");
}
