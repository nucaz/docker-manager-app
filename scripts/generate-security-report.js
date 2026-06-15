// scripts/generate-security-report.js
// Genera SECURITY-REPORT.pdf usando Electron's printToPDF
// Uso: node scripts/generate-security-report.js  (desde la raíz del proyecto)
//       electron scripts/generate-security-report.js

'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs   = require('fs');

const HTML_PATH = path.join(__dirname, '..', 'security-report-src.html');
const PDF_PATH  = path.join(__dirname, '..', 'SECURITY-REPORT.pdf');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  await win.loadFile(HTML_PATH);
  const pdfData = await win.webContents.printToPDF({
    marginsType: 0,
    pageSize: 'A4',
    printBackground: true,
    landscape: false,
  });
  fs.writeFileSync(PDF_PATH, pdfData);
  console.log(`PDF generado: ${PDF_PATH}`);
  app.quit();
});
