# Restaurant POS (offline)

A lightweight, fully offline restaurant billing system for Windows 10/11. It's built for an old **Core i3 PC with 4 GB RAM**.

* **Billing screen:** halls and table layouts on the same page as the order panel. Click a table, add items by **code** or name, set quantities, print the bill, and settle and clear the table.
* **Configuration (admin PIN):**
  * **Menu list:** unique item codes, categories, veg/non-veg, availability, and CSV import/export.
  * **Halls and layout:** multiple halls, each with its own drag-and-drop table layout.
  * **Restaurant and tax:** name, address, GSTIN, FSSAI, **CGST %**, **SGST %**, GST-inclusive pricing, round-off, and bill numbering.
  * **Printer:** browser printing, a USB/Windows printer using raw ESC/POS, or a LAN printer using ESC/POS on port 9100.
  * **Security and backup:** change the admin PIN, back up now, and set how long to keep backups.
* **Table states:** Free (green), Occupied (orange), and Bill printed (blue). You can mark a table as occupied before ordering, move an order to another table, cancel an order (needs the admin PIN), and settle with Cash, UPI, Card, or Other.
* **Past orders:** every bill for today, this week, last month, or any date range. Each bill shows its items. You can search, filter by category, see CGST/SGST totals and the payment-mode split, reprint (marked DUPLICATE), and export to CSV for your accountant.
* **Analytics dashboard:**
  * Headline numbers compared with the previous period of the same length.
  * Charts: sales trend, **category split** (for example Food / Juices / Desserts) with item-level detail, payment modes, busy hours, day of week, halls, and top items.
  * Category reports can be printed or exported, for example to settle with an outside juice counter.
* **Session closings:** configurable sessions (for example Morning, Afternoon, Night). Closing a session shows and prints its summary: income, GST, total, payment modes, and categories.
* **All data stays on this PC** in one file (`data\pos.db`). Nothing is sent to the internet.
* **Automatic daily backups**, plus scripts to back up, restore, and reset a forgotten PIN.
* **Multiple devices:** other PCs, tablets, or phones on the same Wi-Fi/LAN can open the POS in a browser. Screens refresh every 5 seconds.

---

## 1. Tech stack and why it suits an old PC

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24 LTS** (portable, no installer needed) | One ~80 MB folder. The server uses about **50 MB RAM**. |
| Database | **SQLite** built into Node (`node:sqlite`), WAL mode, `synchronous=FULL` | A single file (`data\pos.db`) with no database server to run. Data survives power cuts. |
| Backend | Plain Node `http` server with **zero npm dependencies** | Nothing to download, compile, or break offline. |
| Front end | Vanilla HTML/CSS/JS ES modules, no build step | Loads instantly and is easy to change. |
| Browser | **Microsoft Edge** (already on Windows 10/11) in app/kiosk mode with `--kiosk-printing` | Prints silently and has no tabs or address bar to distract staff. |
| Printing | Browser print, raw ESC/POS through the Windows spooler, or raw ESC/POS over TCP 9100 | Works with almost any 58/80 mm thermal printer (Epson, TVS, Xprinter, Rugtek, Everycom, …). |

Expected resource use: about 50 MB for the server and 250–400 MB for one Edge window. That leaves plenty of headroom on 4 GB.

**Hardware recommendations (in order of impact):**
1. **Replace the hard disk with a cheap SATA SSD (120–240 GB).** This is the biggest speed-up for an old i3 PC: Windows boots in seconds instead of minutes.
2. **Use a UPS.** The POS saves every change safely, but sudden power cuts can still corrupt Windows itself.
3. 4 GB RAM is enough. 8 GB helps only if the PC is also used for other things.

---

## 2. Folder layout

```
RestaurantPOS\
  setup.bat            one-time setup on the billing PC
  start-pos.bat        start server + open POS window
  stop-pos.bat         stop the server
  backup.bat           manual backup  (backup.bat E:\POS-Backups  -> also copies to pen drive)
  restore.bat          restore a backup
  reset-pin.bat        reset admin PIN to 1234
  clear-demo-data.bat  remove demo halls/tables/menu/bills (keeps PIN & settings)
  prepare-offline.bat  run on an INTERNET PC: downloads portable Node.js into runtime\
  server\              backend (Node.js)
  public\              front end (HTML/CSS/JS)
  scripts\             PowerShell/Node helper scripts
  test\                automated tests
  runtime\             portable Node.js (created by prepare-offline.bat)
  data\pos.db          YOUR DATA (created on first run)
  backups\             automatic + manual backups
  logs\                server logs
```

---

## 3. Installation (the billing PC stays offline)

### Step A: On any PC with internet (one time)

1. Copy this whole folder to that PC, or `git clone` the repository there.
2. Double-click **`prepare-offline.bat`**. It downloads the portable Node.js 24 LTS (64-bit), checks its SHA-256 checksum, and puts it in `runtime\`.
3. Copy the whole folder, including `runtime\`, to a pen drive.

> **If you use git:** `runtime\`, `data\`, `backups\` and `logs\` are excluded by `.gitignore`. A fresh clone therefore has **no Node.js runtime** and **no restaurant data**. Always run `prepare-offline.bat` after cloning, before copying the folder to the billing PC. Never commit `data\` or `backups\`, because they contain your sales data.
>
> **When updating an existing install,** copy only the code into `C:\RestaurantPOS`: `server\`, `public\`, `scripts\`, `*.bat`, `package.json`, `README.md`. Don't overwrite or delete the billing PC's `data\`, `backups\` or `runtime\` folders.

> Alternative: install **Node.js 24 LTS (64-bit) MSI** on the billing PC from a USB drive. Or put the MSI file in a folder called `installers\` and run `setup.bat` as Administrator; it installs Node silently.

### Step B: On the billing PC

1. Copy the folder to **`C:\RestaurantPOS`**. Avoid the Desktop and Downloads folders.
2. Double-click **`setup.bat`**. It:
   * checks Node.js and its built-in SQLite
   * creates `data\`, `backups\`, `logs\` and the database (with demo halls and menu items so you can try it straight away)
   * creates the desktop shortcuts **Restaurant POS** and **Stop POS server**
   * makes the POS **start automatically** when Windows logs in
   * turns off sleep and hibernate on AC power

   Options (run from a Command Prompt in the folder):

   | Command | Effect |
   |---|---|
   | `setup.bat -Kiosk` | Shortcuts open the POS full-screen. Staff can't reach the desktop; Alt+F4 exits. |
   | `setup.bat -AllowLan` | **Run as Administrator.** Opens the firewall so tablets, phones, and other PCs can connect. Prints the URL to use. |
   | `setup.bat -NoAutostart` | Don't start the POS at login. |
   | `setup.bat -RemoveAutostart` | Remove auto-start. |
   | `setup.bat -Port 8080` | Use another port (default 3000). |

3. Double-click **Restaurant POS** on the desktop.

### Step C: First-time configuration (as owner)

1. Click **Configuration**, then log in with PIN **`1234`**.
2. **Security and backup:** **change the PIN** first.
3. **Restaurant and tax:** fill in the name, address, phone, GSTIN, FSSAI, CGST % and SGST % (restaurants are usually 2.5 + 2.5), bill prefix, and footer. If your menu prices already include GST, tick **Menu prices already include GST**.
   > **Remove the demo data in one go:** close the POS window and run **`clear-demo-data.bat`**, then type `YES`. It deletes all halls, tables, menu items and bills, and restarts bill numbering at 1. Your PIN and settings are kept, and a backup is saved first. Run it before going live; it also deletes real bills.
4. **Menu list:** delete the demo items (if you didn't use `clear-demo-data.bat`) and add your own. Give every item a unique short **code** (for example 101, 102, or PBM). To add many items at once, use **Import CSV** (format below).
5. **Halls and layout:** rename or delete the demo halls and add your own. In each hall:
   * Add square, round, or long tables.
   * Drag tables into place. Drag the blue corner to resize.
   * Click a table to change its name, number of seats, or shape.
   * Click **Save layout**.
6. **Sessions & closing:** set your session names and times.
7. **Printer:** see section 5, then click **Print test page**.

**Menu CSV format.** The first row must be the header. The `category`, `veg` and `available` columns are optional.

```
code,name,category,price,veg,available
101,Veg Soup,Starters,90,1,1
202,Chicken Biryani,Main Course,260,0,1
```

Tip: use **Export CSV** to get a template. Edit it in Excel and import it again. Items with the same code are updated, not duplicated.

---

## 4. Daily use (staff)

1. **Seat guests:** click a free (green) table, then **Mark as occupied**. This step is optional; adding an item also marks the table occupied.
2. **Add items:**
   * Type an item **code** or part of its name, choose it with Enter or the arrow keys, type the quantity, and press Enter.
   * **Fast entry:** type `101*2` and press Enter to add 2 of item 101 at once.
   * Or tap items in the quick menu, filtered by category chips.
   * Change quantities with − / + or by typing. Remove a line with ×. Enter a discount % if needed.
3. **Print bill:** the bill gets its number and the table turns blue. If more items are added afterwards, press **Reprint bill**.
4. **Settle and clear:** choose Cash, UPI, Card, or Other and enter the waiter's name (names used before are suggested). The waiter is printed on the bill. The bill is saved and the table turns green again.
5. Other actions:
   * **Move to table…** shifts the order to another free table.
   * **Cancel order** needs the admin PIN; cancelled orders are logged in reports.
   * **Clear table** frees an occupied table that has no items.

**Past orders** (admin): choose *Today, Yesterday, This week, Last week, This month, Last month, This FY*, or any dates. Every bill is listed with its items, GST, payment mode, and waiter. You can search by bill number, table, item, or waiter, filter by category, view or reprint a bill, and export to CSV for GST filing.

**Dashboard** (admin) uses the same period picker. It shows:
* Net collected, bills, average bill, items sold, discounts, GST, and cancelled orders. ▲▼ shows the change compared with the previous period of the same length.
* Charts: sales by hour, day, or month; payment modes; **category split**; busy hours; day of week; halls; and top items.

**Tracking juices (or any outside counter)**
1. Put all juice items in one menu category, for example `Juices`.
2. On the Dashboard, go to *Category split* and click **Juices**. You'll see each juice's quantity and amount for the period.
3. Click **Print** or **Export CSV** to hand the report over or reconcile with the juice counter.

Notes:
* If you expand only some categories, Print and Export include just those.
* Amounts are after the bill discount and before GST.
* Each order line keeps the category it had when it was sold. Editing the menu later doesn't change past reports.

**Closing a session (admin)**

The day is split into sessions such as Morning, Afternoon and Night. You set them up in **Configuration → Sessions & closing**; the defaults are 06:00–11:30, 11:30–17:00 and 17:00–23:30. A session can run past midnight, for example 18:00–01:00.

When a session has ended, an orange **Close … session** button appears at the top of every screen. Click it, or open **Closings**, and log in with the admin PIN. The screen shows:
* **Income** (sales after discount, excluding GST) **+ GST** (CGST and SGST) **= Total collected**
* the number of bills and the bill-number range
* the split by payment mode (count the cash against it) and by category
* any cancelled orders

Click **Close session**. Leave **Print closing report** ticked to get the slip on the thermal printer.

Which bills go into a closing:
* A closing takes every settled bill that isn't in an earlier closing, up to the moment you close. A bill settled a few minutes after the session's end time still counts. Bills settled after you close go to the next closing.
* If a session wasn't closed, it must be closed first. It then includes bills up to the start of the next session. Within the grace period (30 minutes by default; change it in the settings) it also keeps late bills settled after that start.
* Tables that are still open aren't included. They're counted in whichever closing comes after they're settled.

**Closings → Past closings** lists closings for any period with totals. You can **View** or **Print** any of them again. **Undo** re-opens the most recent closing, for example if it was closed too early; its bills are then included in the next closing.

---

## 5. Thermal printer setup

First, **install the printer's Windows driver** (it's on the CD or pen drive that came with the printer; many cheap printers use the "POS-58"/"POS-80" driver). Then pick one mode in **Configuration → Printer**:

### Mode 1: Browser print (default; works with any driver)
1. In Windows, go to **Settings → Bluetooth and devices → Printers**. Set the thermal printer as the **default printer**. Turn off "Let Windows manage my default printer".
2. In the printer's **Printing preferences**, set the paper to **80 mm (or 58 mm) receipt / roll**. If the driver has the option, enable **cut at end of document**.
3. The POS shortcut opens Edge with `--kiosk-printing`, so bills print **instantly with no dialog**.
   *If a print dialog still appears, close **all** POS windows and start again from the desktop shortcut.*

### Mode 2: Windows printer, raw ESC/POS (recommended for USB printers)
Choose **Windows printer – raw ESC/POS** and pick the printer from the list. The POS sends printer commands directly, which gives sharp text, bold headings, and automatic paper cut. No default-printer setting is needed.

The list shows each printer's **port** and **driver**. USB receipt printers are listed first, and virtual printers (PDF, XPS, OneNote, Fax) are grouped at the bottom.

**Which one is my printer?** Most Indian thermal printers don't use their brand name in Windows. **LS (Logon Systems)**, Xprinter, Rugtek, Everycom and similar printers install as **`POS-80C`**, **`POS-80`** or **`POS-58`** on a **`USB001`** (or `USB002`…) port. To be sure:
1. Unplug the printer's USB cable.
2. Click **Refresh printer list**. Your printer is the one that disappears or shows **OFFLINE**.
3. Plug the cable back in, refresh again, select it, **Save**, then **Print test page**.

**LS / Logon Systems printers:** if the printer doesn't appear at all, install the driver from the LS website, under the *Downloads → Printer Drivers* section ("POS Printer Driver V7.17" for LS-230 and similar models). Do this on a PC with internet and copy the installer to the billing PC with a pen drive. The blue light on the front usually just means power is on. A red or flashing light usually means the paper has run out or the cover is open.

### Mode 3: Network printer, ESC/POS (LAN/Wi-Fi printers)
1. Hold the printer's FEED button while switching it on to print a self-test page that shows its **IP address**.
2. Give the printer a fixed IP (from the printer's web page or a router DHCP reservation).
3. Choose **Network printer**, enter the IP, and keep port **9100**.

Set the **paper width** (58 or 80 mm) and **copies per bill**, save, and press **Print test page**.

| Problem | Fix |
|---|---|
| Garbled characters / lots of paper (Mode 2) | The driver is in graphics-only mode. Use the "Generic / Text Only" driver or the manufacturer's POS driver. Or use Mode 1. |
| "Cannot open printer" | The printer name changed. Pick it again in Configuration → Printer. |
| Network printer timed out | Check the IP with `ping 192.168.x.x`. The PC and printer must be on the same network. |
| Text too small/large in Mode 1 | Change the paper size in the printer driver preferences. |
| ₹ symbol shows as `Rs.` | Expected in ESC/POS modes; most thermal printers can't print ₹. |

---

## 6. Where data is stored, and backups (please read)

All data (menu, halls, settings, and every bill) is kept in **one file on this PC: `data\pos.db`** (SQLite).
* The POS never needs or uses the internet.
* The browser starts with background networking turned off.
* Fonts and chart code are all local; nothing is loaded from online sources.

To move or archive your data, you only need that file or any backup file.


* **Automatic:** a backup is saved to `backups\` every day while the POS runs. Automatic backups are kept for 30 days; you can change this in Security and backup.
* **Manual:** use **Back up now** in Configuration, or double-click `backup.bat`.
* **Off-site:** at least weekly, run `backup.bat E:\POS-Backups`, replacing `E:` with your pen drive letter. If the PC's disk dies, your data is safe on the pen drive.
* **Restore:** double-click `restore.bat`, choose a backup, and type `YES`. The current database is saved as `backups\pos-before-restore-*.db` before it's replaced.
* **Moving to a new PC:** copy the whole folder, including `data\`, then run `setup.bat`.
* **Forgot the PIN:** run `reset-pin.bat`. The PIN becomes 1234.

---

## 7. Using tablets, phones, or a second PC (optional)

1. On the billing PC, run `setup.bat -AllowLan` **as Administrator**. It shows something like `http://192.168.1.20:3000`.
2. Give the billing PC a **fixed IP**: either a DHCP reservation in the router, or set one in Windows network adapter settings.
3. On the other device, open that URL in Chrome or Edge and use **Add to Home screen** for an app-like icon.
   Printing from other devices: use the **Windows** or **Network** printer mode so the *server* prints the bill. Browser mode prints to the printer attached to the device itself.

No internet is required; only a local Wi-Fi router or switch.

---

## 8. Making the old i3 PC run smoothly

* **SSD** (see above). This gives by far the biggest improvement.
* **Task Manager → Startup apps:** disable everything you don't need (OneDrive, Teams, Spotify, updaters, …).
* **Settings → Privacy → General / Diagnostics:** turn off background apps and tips.
* **System → Advanced system settings → Performance → Adjust for best performance.** Then re-enable "Smooth edges of screen fonts".
* Keep the POS as the only open program. Use `setup.bat -Kiosk` so staff can't open other apps.
* **Windows Update:** because the PC is offline it won't update by itself. Connect it to the internet once in a while, *outside business hours*, to install security updates. After that, run `prepare-offline.bat` on another PC only if you want a newer Node.js.
* **Auto-login (optional):** Win+R → `netplwiz` → untick "Users must enter a user name and password". Then the POS comes up by itself after a power cut.
* **Screen size:** the UI is designed for **1366×768 or larger**. Ctrl + / Ctrl − zooms the POS window.

---

## 9. Scripts reference

| Script | What it does |
|---|---|
| `prepare-offline.bat` | (Internet PC) Downloads portable Node.js 24 LTS into `runtime\` and verifies its checksum. |
| `setup.bat [options]` | Checks the runtime, creates the DB/folders, creates shortcuts and auto-start, sets up the firewall (`-AllowLan`), and changes power settings. |
| `start-pos.bat [-Kiosk] [-ServerOnly] [-Port N]` | Starts the server hidden if it isn't running, waits until it's ready, and opens Edge/Chrome in app or kiosk mode with silent printing. |
| `stop-pos.bat` | Stops the server. |
| `backup.bat [folder]` | Saves a consistent backup (safe while running), optionally copied to a folder or pen drive. |
| `restore.bat [-File path]` | Restores a backup, keeping a copy of the current database. |
| `reset-pin.bat` | Resets the admin PIN to 1234. |
| `clear-demo-data.bat [--yes]` | Backs up, then deletes all halls, tables, menu items, bills and closings. Keeps the PIN and all settings, and restarts bill numbering at 1. |

Logs are in `logs\server.log` and `logs\server-error.log`.

Advanced: the environment variables `PORT`, `HOST`, `POS_DATA_DIR` and `POS_BACKUP_DIR` override the defaults.

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Shortcut does nothing / "server did not start" | Check `logs\server-error.log`. Often port 3000 is in use; run `setup.bat -Port 3100`. |
| "Node.js not found" | Run `prepare-offline.bat` on an internet PC and copy `runtime\` over. |
| Blank page | Press Ctrl+F5. Make sure `stop-pos.bat` followed by `start-pos.bat` works. |
| Other devices can't connect | Run `setup.bat -AllowLan` as admin. Set the Windows network profile to **Private**. Check the IP. |
| Wrong date/time on bills | Fix the Windows clock. If the time resets after power-off, replace the motherboard's CMOS battery (CR2032). |

---

## 11. For developers

```
npm start          # run the server on http://localhost:3000 (needs Node >= 22.13)
npm test           # API + billing tests (node:test, uses a temp database)
```

* `server/index.js`: HTTP server, REST API, auto-backup
* `server/db.js`: SQLite schema, defaults, demo seed, PIN hashing (scrypt)
* `server/billing.js`: GST calculation (exclusive and inclusive pricing, discount, round-off)
* `server/analytics.js`: dashboard figures (trend, category/item split, payment modes, hours, halls, comparison with the previous period)
* `server/closings.js`: session rules, closing summaries, close and undo
* `server/escpos.js`, `server/printer.js`, `scripts/raw-print.ps1`: ESC/POS receipts, sent over TCP or through the Windows spooler
* `public/js/*`: billing screen, configuration, reports, floor-plan renderer/editor, receipt HTML

Possible next steps: kitchen order tickets (KOT), splitting bills, item-level notes, waiter assignment, and a GST HSN/SAC summary.
