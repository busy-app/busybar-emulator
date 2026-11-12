// Draws the icon's pictures: Electron's main script for tools/app-icon.mjs, which starts it with a job file and
// reads its answer. Chromium draws each SVG on a canvas of exactly the pixels asked for, so a line of the drawing
// lands where the drawing says. No window is shown, nothing is loaded from anywhere.
//   electron tools/app-icon/render.mjs <job.json> <answer.json>
// job: { images: [{ svg, size }], sheet?: { rows: [{ label, cells: [{ image, label, zoom? }] }] } }
// answer: { images: [{ png, rgba }], sheet?: png }, base64
import { readFileSync, writeFileSync } from "node:fs";

import { app, BrowserWindow } from "electron";

const [jobFile, answerFile] = process.argv.slice(2);

/** Runs in the page. */
const DRAW = async (job) => {
  const load = (address) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("a picture could not be read"));
      image.src = address;
    });
  const base64 = (bytes) => {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const canvases = [];
  const images = [];
  for (const { svg, size } of job.images) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    context.drawImage(await load(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`), 0, 0, size, size);
    canvases.push(canvas);
    images.push({ png: canvas.toDataURL("image/png").split(",")[1], rgba: base64(context.getImageData(0, 0, size, size).data) });
  }
  if (!job.sheet) return { images };

  // The sheet: every row once on white and once on black, each picture at its own pixels with its label under it.
  const GAP = 28;
  const LABEL = 30;
  const TITLE = 34;
  // A cell with a zoom shows its pixels that many times larger, each pixel a square.
  const shown = (cell) => job.images[cell.image].size * (cell.zoom ?? 1);
  const rowHeight = (row) => TITLE + Math.max(...row.cells.map(shown)) + LABEL;
  const rowWidth = (row) => row.cells.reduce((sum, cell) => sum + Math.max(shown(cell), 86) + GAP, GAP);
  const half = Math.max(...job.sheet.rows.map(rowWidth));
  const height = job.sheet.rows.reduce((sum, row) => sum + rowHeight(row), GAP);
  const sheet = document.createElement("canvas");
  sheet.width = half * 2;
  sheet.height = height;
  const context = sheet.getContext("2d");
  context.imageSmoothingEnabled = false;
  for (const [side, background, ink] of [[0, "#ffffff", "#111111"], [1, "#16161a", "#f2f2f2"]]) {
    context.fillStyle = background;
    context.fillRect(side * half, 0, half, height);
    let y = GAP / 2;
    for (const row of job.sheet.rows) {
      context.fillStyle = ink;
      context.font = "600 13px -apple-system, 'Segoe UI', sans-serif";
      context.textAlign = "left";
      context.fillText(row.label, side * half + GAP, y + 20);
      const tallest = Math.max(...row.cells.map(shown));
      let x = side * half + GAP;
      for (const cell of row.cells) {
        const size = shown(cell);
        const width = Math.max(size, 86);
        context.drawImage(canvases[cell.image], Math.round(x + (width - size) / 2), y + TITLE + tallest - size, size, size);
        context.font = "11px -apple-system, 'Segoe UI', sans-serif";
        context.textAlign = "center";
        context.fillText(cell.label, x + width / 2, y + TITLE + tallest + 18);
        x += width + GAP;
      }
      y += rowHeight(row);
    }
  }
  return { images, sheet: sheet.toDataURL("image/png").split(",")[1] };
};

app.dock?.hide();
app.whenReady().then(async () => {
  let code = 0;
  try {
    const job = JSON.parse(readFileSync(jobFile, "utf8"));
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL("about:blank");
    const answer = await window.webContents.executeJavaScript(`(${DRAW})(${JSON.stringify(job)})`);
    writeFileSync(answerFile, JSON.stringify(answer));
  } catch (e) {
    console.error(`app-icon: ${e.message}`);
    code = 1;
  }
  app.exit(code);
});
