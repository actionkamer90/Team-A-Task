#!/usr/bin/env node
'use strict';
// Import tasks from the Team A Daily Task Tracker Excel workbook (.xlsx or .xlsm).
//
// Usage:
//   node scripts/import-xlsx.js <workbook.xlsm> [--replace] [--dry-run]
//
// Reads the "Daily Task Tracker" sheet (active tasks), the "Archive" sheet (archived tasks)
// and the "Customer" sheet (customer list). Existing tasks with the same Task No are updated;
// --replace deletes every task first.
const path = require('node:path');
const ExcelJS = require('exceljs');
const { open, repo } = require('../src/db');
const { CATEGORIES, URGENCIES } = require('../public/logic.js');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const replace = args.includes('--replace');
const dryRun = args.includes('--dry-run');
if (!file) {
  console.error('Usage: node scripts/import-xlsx.js <workbook.xlsm> [--replace] [--dry-run]');
  process.exit(1);
}

const pad = (n) => String(n).padStart(2, '0');
const warnings = [];

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
  }
  return v;
}

function toDate(v, where) {
  v = cellValue(v);
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.getUTCFullYear() + '-' + pad(v.getUTCMonth() + 1) + '-' + pad(v.getUTCDate());
  if (typeof v === 'number') {
    // Excel serial date
    const d = new Date(Date.UTC(1899, 11, 30) + v * 864e5);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/); // dd-mm-yyyy (Malaysian format)
  let y; let mo; let d;
  if (m) { [, d, mo, y] = m.map(Number); } else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { [, y, mo, d] = m.map(Number); } else {
    warnings.push(`${where}: could not read date "${s}", left empty.`);
    return null;
  }
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (mo < 1 || mo > 12) { warnings.push(`${where}: invalid date "${s}", left empty.`); return null; }
  if (d > last) {
    warnings.push(`${where}: "${s}" does not exist, used ${y}-${pad(mo)}-${pad(last)} instead.`);
    d = last;
  }
  return `${y}-${pad(mo)}-${pad(d)}`;
}

const people = (v) => String(cellValue(v) ?? '').split('/').map((p) => p.trim()).filter((p) => p && p.toLowerCase() !== 'none');
const text = (v) => String(cellValue(v) ?? '').trim();

function readSheet(ws, archived) {
  const out = [];
  if (!ws) return out;
  // Find header row columns by name, so column order changes don't break the import.
  const header = {};
  ws.getRow(1).eachCell((c, col) => { header[text(c.value).toLowerCase()] = col; });
  const col = (...names) => names.map((n) => header[n.toLowerCase()]).find(Boolean);
  const C = {
    no: col('Task No'), cat: col('Categories', 'Category'), title: col('Main Task / Project'), progress: col('Task Progress'),
    pct: col('Task Percentage'), urg: col('Urgency'), cust: col('Customer'), lead: col('Lead Engineer', '1st Engineer'),
    sup: col('Support Engineer', '2nd Engineer'), start: col('Start Date'), target: col('Target Date'), actual: col('Actual Date'),
  };
  if (!C.title) throw new Error(`Sheet "${ws.name}" has no "Main Task / Project" column.`);
  ws.eachRow((row, r) => {
    if (r === 1) return;
    const get = (k) => (C[k] ? row.getCell(C[k]).value : null);
    const title = text(get('title'));
    if (!title) return;
    const where = `${ws.name} row ${r}`;
    const no = Number(cellValue(get('no')));
    let category = text(get('cat'));
    if (!CATEGORIES.includes(category)) { if (category) warnings.push(`${where}: unknown category "${category}", used Tickets.`); category = 'Tickets'; }
    let urgency = text(get('urg'));
    if (!URGENCIES.includes(urgency)) { if (urgency) warnings.push(`${where}: unknown urgency "${urgency}", used Medium.`); urgency = 'Medium'; }
    let pct = Number(cellValue(get('pct')) || 0);
    if (pct > 1) pct /= 100;
    pct = Math.min(1, Math.max(0, pct || 0));
    const lead = people(get('lead'));
    if (!lead.length) warnings.push(`${where}: no lead engineer.`);
    out.push({
      no: Number.isInteger(no) && no > 0 ? no : null,
      category, title: title.slice(0, 300), progress: text(get('progress')), pct, urgency,
      customer: text(get('cust')), lead, support: people(get('sup')).filter((p) => !lead.includes(p)),
      start: toDate(get('start'), where + ' Start Date'), target: toDate(get('target'), where + ' Target Date'),
      actual: toDate(get('actual'), where + ' Actual Date'), archived, where,
    });
  });
  return out;
}

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const active = readSheet(wb.getWorksheet('Daily Task Tracker'), false);
  const archive = readSheet(wb.getWorksheet('Archive'), true);
  const tasks = [...active, ...archive];
  const customers = [];
  const custWs = wb.getWorksheet('Customer');
  if (custWs) custWs.eachRow((row) => { const c = text(row.getCell(1).value); if (c && !customers.includes(c)) customers.push(c); });

  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const store = repo(open(path.join(dataDir, 'tracker.db')));

  // Give rows without a number (or with a duplicate) the next free number.
  const used = new Set(replace ? [] : store.listTasks().map((t) => t.no));
  const seen = new Set();
  let next = Math.max(0, ...used, ...tasks.map((t) => t.no || 0)) + 1;
  for (const t of tasks) {
    if (!t.no || seen.has(t.no)) {
      const n = next++;
      warnings.push(`${t.where}: ${t.no ? 'duplicate' : 'missing'} Task No${t.no ? ' ' + t.no : ''}, numbered ${n}.`);
      t.no = n;
    }
    seen.add(t.no);
  }

  console.log(`Read ${active.length} active and ${archive.length} archived tasks, ${customers.length} customers from ${path.basename(file)}.`);
  for (const w of warnings) console.log('  note: ' + w);
  if (dryRun) { console.log('Dry run: nothing written.'); return; }

  let created = 0; let updated = 0;
  store.tx(() => {
    if (replace) store.deleteAllTasks();
    for (const t of tasks) {
      if (!t.lead.length) t.lead = ['Unassigned'];
      if (store.getTask(t.no)) { store.updateTask(t.no, t, null); updated++; } else { store.insertTask(t, null); store.logActivity(t.no, null, 'created', 'Imported from Excel'); created++; }
    }
    if (customers.length) {
      const s = store.getSettings();
      s.customers = [...new Set([...s.customers, ...customers])].sort((a, b) => a.localeCompare(b));
      store.saveSettings(s);
    }
  });
  store.db.close();
  console.log(`Done: ${created} tasks added, ${updated} updated.`);
})().catch((e) => {
  console.error('Import failed: ' + e.message);
  process.exit(1);
});
