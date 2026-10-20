'use strict';
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RAW_PRINT_SCRIPT = path.join(__dirname, '..', 'scripts', 'raw-print.ps1');

function sendToNetworkPrinter(buffer, host, port = 9100, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    if (!host) return reject(new Error('Printer IP address is not configured'));
    const socket = net.createConnection({ host, port: Number(port) || 9100 });
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.end(buffer));
    socket.on('timeout', () => { socket.destroy(); reject(new Error(`Printer ${host}:${port} timed out`)); });
    socket.on('error', (e) => reject(new Error(`Printer ${host}:${port}: ${e.message}`)));
    socket.on('close', (hadError) => { if (!hadError) resolve(); });
  });
}

function sendToWindowsPrinter(buffer, printerName) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('Windows printing is only available on Windows'));
    if (!printerName) return reject(new Error('Windows printer name is not configured'));
    const tmp = path.join(os.tmpdir(), `pos-print-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(tmp, buffer);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RAW_PRINT_SCRIPT, '-PrinterName', printerName, '-Path', tmp],
      { windowsHide: true, timeout: 30000 },
      (err, stdout, stderr) => {
        fs.unlink(tmp, () => {});
        if (err) return reject(new Error((stderr || stdout || err.message).trim()));
        resolve();
      }
    );
  });
}

async function print(buffer, settings) {
  const copies = Math.max(1, Math.min(5, Number(settings.printCopies) || 1));
  for (let i = 0; i < copies; i++) {
    if (settings.printerMode === 'network') await sendToNetworkPrinter(buffer, settings.printerIp, settings.printerPort);
    else if (settings.printerMode === 'windows') await sendToWindowsPrinter(buffer, settings.printerName);
    else throw new Error('Printer mode is "browser" - printing is done from the browser');
  }
}

// Returns installed Windows printers with port/driver details. Receipt printers on USB are listed first;
// virtual printers (PDF, XPS, OneNote, Fax) are flagged so the UI can de-emphasise them.
function listWindowsPrinters() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const ps = 'Get-CimInstance Win32_Printer | Select-Object Name, PortName, DriverName, Default, WorkOffline | ConvertTo-Json -Compress';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err || !stdout.trim()) return resolve([]);
      let rows;
      try { rows = JSON.parse(stdout); } catch { return resolve([]); }
      if (!Array.isArray(rows)) rows = [rows];
      const list = rows.map((p) => {
        const name = String(p.Name || ''), port = String(p.PortName || ''), driver = String(p.DriverName || '');
        const text = `${name} ${driver}`;
        const virtual = /PORTPROMPT|^nul:?$|SHRFAX|^FILE:|XPS|OneNote|PDF|Fax|AnyDesk/i.test(`${port} ${text}`) && !/^USB/i.test(port);
        const receipt = !virtual && (/^USB/i.test(port) || /POS|receipt|thermal|TM-|XP-|RP\d|\b(58|80)\s?mm|\bLS[- ]?\d/i.test(text));
        return { name, port, driver, isDefault: !!p.Default, offline: !!p.WorkOffline, virtual, receipt };
      });
      list.sort((a, b) => (b.receipt - a.receipt) || (a.virtual - b.virtual) || a.name.localeCompare(b.name));
      resolve(list);
    });
  });
}

module.exports = { print, listWindowsPrinters };
