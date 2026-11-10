'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TT = require('../public/logic.js');

test('status follows the workbook formula', () => {
  const now = '2026-11-10';
  assert.equal(TT.status({ target: '2026-11-09' }, now), 'Delay');
  assert.equal(TT.status({ target: '2026-11-10' }, now), 'On-Going');
  assert.equal(TT.status({ target: null }, now), 'On-Going');
  assert.equal(TT.status({ target: '2026-11-10', actual: '2026-11-09' }, now), 'Completed Early');
  assert.equal(TT.status({ target: '2026-11-10', actual: '2026-11-10' }, now), 'Completed On Time');
  assert.equal(TT.status({ target: '2026-11-10', actual: '2026-11-11' }, now), 'Completed Late');
  assert.equal(TT.status({ target: null, actual: '2026-11-11' }, now), 'Completed');
});

test('readyToArchive uses the archive delay like the macro', () => {
  const tasks = [
    { no: 1, actual: '2026-11-08', archived: false },
    { no: 2, actual: '2026-11-09', archived: false },
    { no: 3, actual: '2026-11-01', archived: true },
    { no: 4, actual: null, archived: false },
  ];
  assert.deepEqual(TT.readyToArchive(tasks, 2, '2026-11-10').map((t) => t.no), [1]);
});

test('kpi matches the weighted dashboard', () => {
  const tasks = [
    { lead: ['Ena'], support: ['Izz'], start: '2026-01-01', target: '2026-01-10', actual: '2026-01-05', urgency: 'High' }, // early
    { lead: ['Ena'], support: [], start: '2026-01-01', target: '2026-01-10', actual: '2026-01-10', urgency: 'Low' }, // on time
    { lead: ['Ena'], support: [], start: '2026-01-01', target: '2026-01-10', actual: '2026-01-14', urgency: 'Critical' }, // 4 days late
    { lead: ['Izz'], support: ['Ena'], start: '2026-01-01', target: '2026-01-10', actual: '2026-01-12', urgency: 'Medium' }, // 2 days late
    { lead: ['Izz'], support: [], start: '2026-01-01', target: '2026-01-10', actual: '2027-01-12', urgency: 'Medium' }, // out of period
  ];
  const { team, rows } = TT.kpi(tasks, { engineers: ['Ena', 'Izz'] }, '2026-01-01', '2026-12-31');
  assert.equal(team.completed, 4);
  assert.equal(team.onTime, 2);
  assert.equal(team.late, 2);
  assert.equal(team.avgDaysLate, 3);

  const ena = rows.find((r) => r.engineer === 'Ena');
  assert.equal(ena.lead, 3);
  assert.equal(ena.support, 1);
  assert.equal(ena.leadLate, 1);
  assert.equal(ena.supportLate, 1);
  assert.equal(ena.totalOnTimePct, 0.5); // (4 - 1 - 1) / 4
  assert.equal(ena.early, 1);
  assert.equal(ena.highLed, 2);
  assert.ok(Math.abs(ena.score - (0.8 * 0.5 + 0.2 * 0.25)) < 1e-9);
  assert.equal(ena.rating, 'At Risk');

  const izz = rows.find((r) => r.engineer === 'Izz');
  assert.equal(izz.total, 2);
  assert.equal(izz.early, 1); // as support on Ena's early task
});
