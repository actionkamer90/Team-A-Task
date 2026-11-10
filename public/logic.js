// Business rules shared by the browser and the server (and the tests).
// Mirrors the formulas in Team_A_Daily_Task_Tracker_Template_2026.xlsm.
(function (root) {
  'use strict';

  const CATEGORIES = ['Pre-Sales', 'Project', 'Tickets', 'Internal'];
  const URGENCIES = ['Low', 'Medium', 'High', 'Critical'];
  const STATUSES = ['On-Going', 'Delay', 'Completed Early', 'Completed On Time', 'Completed Late'];

  const DEFAULT_SETTINGS = {
    engineers: ['Khaidir', 'Arif', 'Izuan', 'Ena', 'Izz', 'Asmadi'],
    customers: [
      'Affin', 'Agro Bank', 'All NFM Customer', 'All Zena Customer', 'Ambank', 'Bank Rakyat', 'BSN',
      'DotDash Internal', 'EPF', 'Hong Leong Bank', 'Internal Testing', 'Koperasi Tentera',
      'Maybank Indonesia', 'Maybank Malaysia', 'Maybank Singapore', 'RHB', 'Telekom Malaysia',
    ],
    wOnTime: 0.8,
    wEarly: 0.2,
    tExcellent: 0.9,
    tGood: 0.7,
    tNeeds: 0.6,
    archiveAfterDays: 2,
  };

  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => isoDate(new Date());
  const addDays = (s, n) => {
    const d = new Date(s + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return isoDate(d);
  };
  const diffDays = (a, b) => Math.round((new Date(a + 'T00:00:00') - new Date(b + 'T00:00:00')) / 864e5);

  // Same rule as the workbook's Status column:
  // =IF(L="",IF(K<TODAY(),"Delay","On-Going"),IF(L<K,"Completed Early",IF(L=K,"Completed On Time","Completed Late")))
  function status(t, now) {
    const t0 = now || today();
    if (!t.actual) return t.target && t.target < t0 ? 'Delay' : 'On-Going';
    if (!t.target) return 'Completed';
    if (t.actual < t.target) return 'Completed Early';
    if (t.actual === t.target) return 'Completed On Time';
    return 'Completed Late';
  }

  function readyToArchive(tasks, archiveAfterDays, now) {
    const cut = addDays(now || today(), -archiveAfterDays);
    return tasks.filter((t) => !t.archived && t.actual && t.actual <= cut);
  }

  // KPI Dashboard (Weighted): Score = Total on-time % x wOnTime + Early % x wEarly
  function kpi(tasks, settings, from, to) {
    const C = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const done = tasks.filter((t) => t.actual && t.actual >= from && t.actual <= to);
    const st = (t) => status(t);
    const onTime = (t) => st(t) === 'Completed Early' || st(t) === 'Completed On Time';
    const late = (t) => st(t) === 'Completed Late';
    const early = (t) => st(t) === 'Completed Early';
    const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

    const team = {
      completed: done.length,
      onTime: done.filter(onTime).length,
      late: done.filter(late).length,
    };
    team.onTimePct = team.completed ? team.onTime / team.completed : 0;
    team.avgDaysLate = avg(done.filter(late).map((t) => diffDays(t.actual, t.target)));
    team.avgCycle = avg(done.filter((t) => t.start).map((t) => diffDays(t.actual, t.start)));

    const rate = (n, s) =>
      !n ? 'No Data' : s >= C.tExcellent ? 'Excellent' : s >= C.tGood ? 'Good' : s >= C.tNeeds ? 'Needs Improvement' : 'At Risk';

    const names = [...new Set([...C.engineers, ...done.flatMap((t) => t.lead || [])])];
    const rows = names
      .map((e) => {
        const L = done.filter((t) => (t.lead || []).includes(e));
        const S = done.filter((t) => (t.support || []).includes(e));
        const r = {
          engineer: e,
          lead: L.length,
          support: S.length,
          total: L.length + S.length,
          leadOnTime: L.filter(onTime).length,
          leadLate: L.filter(late).length,
          supportOnTime: S.filter(onTime).length,
          supportLate: S.filter(late).length,
          early: L.filter(early).length + S.filter(early).length,
          highLed: L.filter((t) => t.urgency === 'High' || t.urgency === 'Critical').length,
          avgDaysLate: avg(L.filter(late).map((t) => diffDays(t.actual, t.target))),
          avgCycle: avg(L.filter((t) => t.start).map((t) => diffDays(t.actual, t.start))),
        };
        r.leadOnTimePct = r.lead ? r.leadOnTime / r.lead : 0;
        r.supportOnTimePct = r.support ? r.supportOnTime / r.support : 0;
        r.totalOnTimePct = r.total ? (r.total - r.leadLate - r.supportLate) / r.total : 0;
        r.earlyPct = r.total ? r.early / r.total : 0;
        r.score = r.total ? C.wOnTime * r.totalOnTimePct + C.wEarly * r.earlyPct : 0;
        r.rating = rate(r.total, r.score);
        return r;
      })
      .filter((r) => r.total || C.engineers.includes(r.engineer))
      .sort((a, b) => b.score - a.score);

    return { team, rows };
  }

  const api = {
    CATEGORIES, URGENCIES, STATUSES, DEFAULT_SETTINGS,
    isoDate, today, addDays, diffDays, status, readyToArchive, kpi,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TT = api;
})(typeof self !== 'undefined' ? self : this);
