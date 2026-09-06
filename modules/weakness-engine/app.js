/* Weakness Engine — แสดงจุดอ่อนที่พิสูจน์ได้ด้วยข้อมูลห้องของ ASHER */
(function () {
  'use strict';

  var state = { data: null, filterProven: false, showDismissed: false };

  var $ = function (id) { return document.getElementById(id); };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var toastTimer = null;
  function toast(message, kind) {
    var el = $('toast');
    el.textContent = message;
    el.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, 4200);
  }

  function setBadge(kind, text) {
    var badge = $('apiBadge');
    badge.className = 'api-badge ' + kind;
    badge.textContent = text;
  }

  function scoreClass(priority) {
    if (priority >= 15) return 'hot';
    if (priority >= 8) return 'warm';
    return 'cool';
  }

  /* -------------------------------- render ------------------------------- */

  function render() {
    var data = state.data;
    if (!data) return;

    $('statReady').textContent = data.summary.ready;
    $('statInteresting').textContent = data.summary.interesting;
    $('statUsed').textContent = data.summary.used;
    $('statWon').textContent = data.summary.won;

    $('blockers').innerHTML = data.blockers.length
      ? '<div class="callout"><strong>ต้องแก้ก่อนถึงจะใช้ได้เต็มที่</strong><div>' +
        data.blockers.map(esc).join('<br>') + '</div></div>'
      : '<div class="callout good"><strong>ข้อมูลครบพอที่จะพิสูจน์ได้แล้ว</strong>' +
        '<div>สแกนจาก ' + data.inputs.competitors + ' คู่แข่ง เทียบกับห้องของ ASHER ' +
        data.inputs.asherRoomsWithSize + ' ผังที่มีขนาดจริง</div></div>';

    var findings = data.findings.filter(function (finding) {
      if (finding.status === 'dismissed' && !state.showDismissed) return false;
      if (state.filterProven && finding.locked) return false;
      return true;
    });

    $('findings').innerHTML = findings.length
      ? findings.map(cardHtml).join('')
      : '<div class="panel"><div class="faint">' +
        (data.findings.length
          ? 'ไม่มีจุดอ่อนที่ตรงกับตัวกรองที่เลือก'
          : 'ยังไม่เจอจุดอ่อน — เพิ่มข้อมูลคู่แข่งก่อน หรือกด “ใส่ข้อมูลตัวอย่าง” เพื่อลองระบบ') +
        '</div></div>';

    bindCardActions();
  }

  function cardHtml(finding) {
    var proofRow = finding.locked
      ? row('ยังพิสูจน์ไม่ได้',
            esc(finding.proof) + ' (ถ้าพิสูจน์ได้ priority จะขึ้นเป็น ' + finding.potentialPriority + ')',
            'locked')
      : row('พิสูจน์แล้ว', esc(finding.proof), 'proven');

    var source = esc(finding.competitorName) +
      (finding.roomLabel ? ' · ' + esc(finding.roomLabel) : '');
    var sourceHtml = finding.competitorWebsite
      ? '<a href="' + esc(finding.competitorWebsite) + '" target="_blank" rel="noreferrer noopener">' +
        esc(finding.competitorName) + '</a>' +
        (finding.roomLabel ? ' · ' + esc(finding.roomLabel) : '')
      : source;

    var classes = ['weak-card'];
    if (finding.status === 'dismissed') classes.push('is-dismissed');
    if (finding.status === 'used') classes.push('is-used');

    return '<div class="' + classes.join(' ') + '" data-id="' + esc(finding.id) + '">' +
      '<div class="weak-head">' +
        '<div>' +
          '<div class="weak-title">' + esc(finding.title) + '</div>' +
          '<div class="weak-source">' + sourceHtml + '</div>' +
        '</div>' +
        '<div class="weak-score">' +
          '<div class="n ' + scoreClass(finding.priority) + '">' + finding.priority + '</div>' +
          '<div class="f">' + finding.severity + ' × ' + finding.exploitability + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="weak-body">' +
        row('หลักฐาน', esc(finding.evidence)) +
        proofRow +
        (finding.angle ? row('มุมโจมตี', esc(finding.angle)) : '') +
        row('คำถามเปิด', esc(finding.openQuestion)) +
        row('ห้ามพูด', esc(finding.doNotSay)) +
      '</div>' +
      actionsHtml(finding) +
    '</div>';
  }

  function row(label, value, modifier) {
    return '<div class="weak-row' + (modifier ? ' ' + modifier : '') + '">' +
      '<div class="k">' + esc(label) + '</div><div class="v">' + value + '</div></div>';
  }

  function actionsHtml(finding) {
    var used = finding.status === 'used';
    var dismissed = finding.status === 'dismissed';
    return '<div class="weak-actions">' +
      '<button class="btn small' + (used ? ' on' : '') + '" data-act="used">ใช้มุมนี้</button>' +
      '<button class="btn small danger' + (dismissed ? ' on' : '') + '" data-act="dismissed">ตัดทิ้ง</button>' +
      '<button class="btn small" data-act="reset">คืนค่า</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn small win' + (finding.outcome === 'won' ? ' on' : '') + '" data-out="won">ใช้แล้วชนะ</button>' +
      '<button class="btn small lose' + (finding.outcome === 'lost' ? ' on' : '') + '" data-out="lost">ใช้แล้วแพ้</button>' +
      '<button class="btn small' + (finding.outcome === 'noeffect' ? ' on' : '') + '" data-out="noeffect">ไม่มีผล</button>' +
      '</div>';
  }

  function bindCardActions() {
    $('findings').querySelectorAll('.weak-card').forEach(function (card) {
      var id = card.dataset.id;
      card.querySelectorAll('[data-act]').forEach(function (button) {
        button.addEventListener('click', function () {
          var act = button.dataset.act;
          sendAction(act === 'reset' ? { id: id, reset: true } : { id: id, status: act });
        });
      });
      card.querySelectorAll('[data-out]').forEach(function (button) {
        button.addEventListener('click', function () {
          // เลือกผลลัพธ์เดิมซ้ำ = ยกเลิกผลลัพธ์นั้น
          var current = findingById(id);
          var next = current && current.outcome === button.dataset.out ? null : button.dataset.out;
          sendAction({ id: id, outcome: next, status: next ? 'used' : undefined });
        });
      });
    });
  }

  function findingById(id) {
    if (!state.data) return null;
    return state.data.findings.filter(function (f) { return f.id === id; })[0] || null;
  }

  /* --------------------------------- data -------------------------------- */

  async function sendAction(payload) {
    try {
      state.data = await AsherAPI.setWeaknessAction(payload);
      render();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function scan(silent) {
    $('scanStatus').textContent = 'กำลังสแกน …';
    try {
      state.data = await AsherAPI.getWeakness();
      setBadge('live', 'LOCAL API · LIVE');
      $('scanStatus').textContent = 'สแกนล่าสุด ' +
        new Date(state.data.generatedAt).toLocaleTimeString('th-TH') +
        ' · คู่แข่ง ' + state.data.inputs.competitors +
        ' · ห้อง ASHER ' + state.data.inputs.asherRoomsWithSize + ' ผัง';
      render();
    } catch (err) {
      setBadge('offline', 'LOCAL API · OFFLINE');
      $('scanStatus').textContent = '';
      $('findings').innerHTML = '<div class="callout bad"><strong>ต่อ Local API ไม่ได้</strong>' +
        '<div>' + esc(err.message) + '</div></div>';
      if (!silent) toast(err.message, 'err');
    }
  }

  $('scanBtn').addEventListener('click', function () { scan(); });

  $('sampleBtn').addEventListener('click', async function () {
    $('sampleBtn').disabled = true;
    try {
      state.data = await AsherAPI.seedSampleCompetitor();
      render();
      toast(state.data.added
        ? 'ใส่ข้อมูลคู่แข่งตัวอย่างแล้ว ' + state.data.added + ' โครงการ'
        : 'มีข้อมูลตัวอย่างอยู่แล้ว', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      $('sampleBtn').disabled = false;
    }
  });

  $('filterProven').addEventListener('change', function () {
    state.filterProven = $('filterProven').checked;
    render();
  });
  $('filterDismissed').addEventListener('change', function () {
    state.showDismissed = $('filterDismissed').checked;
    render();
  });

  scan(true);
})();
