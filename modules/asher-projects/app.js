/* ระบบใส่ข้อมูลโครงการ ASHER — ฟอร์ม + ดึงข้อมูลจากเว็บไซต์ */
(function () {
  'use strict';

  var FIELD_LABELS = {
    name: 'ชื่อโครงการ',
    location: 'ทำเล',
    developer: 'ผู้พัฒนา',
    priceStartTHB: 'ราคาเริ่มต้น (บาท)',
    pricePerSqmTHB: 'ราคาต่อ ตร.ม. (บาท)',
    unitsTotal: 'จำนวนยูนิต',
    floors: 'จำนวนชั้น',
    completionYear: 'ปีที่แล้วเสร็จ'
  };

  var NUMERIC_FIELDS = [
    'priceStartTHB', 'pricePerSqmTHB', 'unitsTotal', 'floors', 'completionYear'
  ];

  var CONFIDENCE_LABELS = { high: 'มั่นใจสูง', medium: 'ปานกลาง', low: 'ต้องตรวจเอง' };

  var state = {
    projects: [],
    activeId: null,
    dirty: false,
    apiLive: false,
    scrape: null
  };

  var $ = function (id) { return document.getElementById(id); };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function numOrNull(value) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    var n = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function fmtNumber(value) {
    if (value === null || value === undefined || value === '') return '—';
    return Number(value).toLocaleString('th-TH');
  }

  var toastTimer = null;
  function toast(message, kind) {
    var el = $('toast');
    el.textContent = message;
    el.className = 'show ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = ''; }, 4200);
  }

  function activeProject() {
    return state.projects.filter(function (p) { return p.id === state.activeId; })[0] || null;
  }

  function markDirty() {
    state.dirty = true;
    $('dirtyFlag').hidden = false;
    renderCompleteness();
  }

  function clearDirty() {
    state.dirty = false;
    $('dirtyFlag').hidden = true;
  }

  /* ------------------------------ โหลดข้อมูล ------------------------------ */

  function setBadge(kind, text) {
    var badge = $('apiBadge');
    badge.className = 'api-badge ' + kind;
    badge.textContent = text;
  }

  async function checkHealth() {
    try {
      await AsherAPI.health();
      state.apiLive = true;
      setBadge('live', 'LOCAL API · LIVE');
    } catch (err) {
      state.apiLive = false;
      setBadge('offline', 'LOCAL API · OFFLINE');
    }
    return state.apiLive;
  }

  function blankProject(name) {
    return {
      id: '', name: name || '', brand: 'ASHER', location: '', website: '',
      developer: '', status: 'selling', priceStartTHB: null, pricePerSqmTHB: null,
      unitsTotal: null, floors: null, completionYear: null, notes: '',
      facilities: [], rooms: [], promotions: [], sources: []
    };
  }

  async function load(preferredId) {
    var loaded = false;
    if (await checkHealth()) {
      try {
        var payload = await AsherAPI.getProjects();
        state.projects = payload.projects || [];
        loaded = true;
      } catch (err) {
        toast(err.message, 'err');
      }
    }
    if (!loaded) {
      // API ล่ม: ใช้ร่างในเครื่องไปก่อน จะได้กรอกต่อได้ไม่สะดุด
      var drafts = AsherAPI.listDrafts();
      state.projects = drafts.map(function (d) { return d.project; });
      if (!state.projects.length) {
        state.projects = [
          Object.assign(blankProject('ASHER Naii'), { id: 'asher-naii', location: 'อินทามระ 41' }),
          Object.assign(blankProject('ASHER Vibe'), { id: 'asher-vibe' })
        ];
      }
    }
    state.activeId = preferredId && state.projects.some(function (p) { return p.id === preferredId; })
      ? preferredId
      : (state.projects[0] ? state.projects[0].id : null);
    clearDirty();
    renderAll();
    renderDraftNotice();
  }

  function renderDraftNotice() {
    var box = $('draftNotice');
    var drafts = AsherAPI.listDrafts();
    if (!drafts.length || !state.apiLive) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    box.className = 'callout';
    box.innerHTML =
      '<strong>มีข้อมูลที่ยังค้างอยู่ในเครื่อง</strong>' +
      '<div>' + drafts.length + ' โครงการถูกบันทึกไว้ในเบราว์เซอร์ตอน API ไม่ทำงาน — ' +
      'ตอนนี้ API กลับมาแล้ว กดซิงก์เพื่อเก็บลงไฟล์จริง</div>' +
      '<button class="btn small" id="syncDraftBtn" style="margin-top:9px">ซิงก์ขึ้น Local API</button>';
    $('syncDraftBtn').addEventListener('click', async function () {
      var result = await AsherAPI.syncDrafts();
      if (result.failed.length) {
        toast('ซิงก์ไม่สำเร็จ ' + result.failed.length + ' รายการ: ' + result.failed[0].error, 'err');
      } else {
        toast('ซิงก์ข้อมูล ' + result.synced.length + ' โครงการเรียบร้อย', 'ok');
      }
      load(state.activeId);
    });
  }

  /* ------------------------------- render ------------------------------- */

  function renderAll() {
    renderTabs();
    renderForm();
    renderRooms();
    renderChips();
    renderSources();
    renderCompleteness();
  }

  function renderTabs() {
    var tabs = $('projectTabs');
    tabs.innerHTML = '';
    state.projects.forEach(function (project) {
      var button = document.createElement('button');
      button.className = 'tab' + (project.id === state.activeId ? ' active' : '');
      var withSize = project.rooms.filter(function (r) { return r.sizeSqm; }).length;
      button.innerHTML = esc(project.name) + ' <span class="faint">· ' + withSize + ' ผัง</span>';
      button.addEventListener('click', function () { switchProject(project.id); });
      tabs.appendChild(button);
    });
    var add = document.createElement('button');
    add.className = 'tab';
    add.textContent = '+ เพิ่มโครงการ';
    add.addEventListener('click', addProject);
    tabs.appendChild(add);
  }

  function switchProject(id) {
    if (id === state.activeId) return;
    if (state.dirty && !window.confirm('ยังมีข้อมูลที่ไม่ได้บันทึก ต้องการเปลี่ยนโครงการเลยหรือไม่?')) return;
    state.activeId = id;
    state.scrape = null;
    $('scrapeResult').hidden = true;
    clearDirty();
    renderAll();
  }

  async function addProject() {
    var name = window.prompt('ชื่อโครงการใหม่', 'ASHER ');
    if (!name || !name.trim()) return;
    var project = Object.assign(blankProject(name.trim()), {
      id: name.trim().toLowerCase().replace(/[^a-z0-9ก-๙]+/g, '-').replace(/^-+|-+$/g, '')
    });
    if (state.apiLive) {
      try {
        var payload = await AsherAPI.createProject(project);
        toast('เพิ่มโครงการ ' + payload.project.name + ' แล้ว', 'ok');
        return load(payload.project.id);
      } catch (err) {
        return toast(err.message, 'err');
      }
    }
    state.projects.push(project);
    state.activeId = project.id;
    markDirty();
    renderAll();
  }

  function renderForm() {
    var project = activeProject();
    document.querySelectorAll('[data-field]').forEach(function (input) {
      var field = input.dataset.field;
      input.value = project && project[field] !== null && project[field] !== undefined
        ? project[field]
        : '';
      input.disabled = !project;
    });
    $('websiteInput').value = project ? (project.website || '') : '';
  }

  function bindFormInputs() {
    document.querySelectorAll('[data-field]').forEach(function (input) {
      input.addEventListener('input', function () {
        var project = activeProject();
        if (!project) return;
        var field = input.dataset.field;
        project[field] = NUMERIC_FIELDS.indexOf(field) === -1
          ? input.value
          : numOrNull(input.value);
        markDirty();
        if (field === 'name') renderTabs();
      });
    });
    $('websiteInput').addEventListener('input', function () {
      var project = activeProject();
      if (!project) return;
      project.website = $('websiteInput').value.trim();
      markDirty();
    });
  }

  var ROOM_COLUMNS = [
    { key: 'type', type: 'text', placeholder: '1 Bedroom (S)' },
    { key: 'sizeSqm', type: 'number', step: '0.1', placeholder: '28.5' },
    { key: 'ceilingHeightM', type: 'number', step: '0.05', placeholder: '2.70' },
    { key: 'priceTHB', type: 'number', step: '10000', placeholder: '3950000' },
    { key: 'pricePerSqmTHB', type: 'number', step: '1000', placeholder: 'คำนวณให้อัตโนมัติ' },
    { key: 'units', type: 'number', step: '1', placeholder: '' },
    { key: 'bedWidthFt', type: 'number', step: '0.5', placeholder: '6' },
    { key: 'notes', type: 'text', placeholder: 'เช่น วางโซฟา 2 ที่นั่งได้' }
  ];

  function renderRooms() {
    var project = activeProject();
    var body = $('roomsBody');
    body.innerHTML = '';
    if (!project) return;

    project.rooms.forEach(function (room, index) {
      var tr = document.createElement('tr');
      ROOM_COLUMNS.forEach(function (column) {
        var td = document.createElement('td');
        var input = document.createElement('input');
        input.type = column.type;
        if (column.step) input.step = column.step;
        if (column.placeholder) input.placeholder = column.placeholder;
        input.value = room[column.key] === null || room[column.key] === undefined ? '' : room[column.key];
        input.addEventListener('input', function () {
          room[column.key] = column.type === 'number' ? numOrNull(input.value) : input.value;
          markDirty();
        });
        if (column.key === 'priceTHB' || column.key === 'sizeSqm') {
          input.addEventListener('blur', function () { autoPricePerSqm(room, index); });
        }
        td.appendChild(input);
        tr.appendChild(td);
      });

      var actions = document.createElement('td');
      var remove = document.createElement('button');
      remove.className = 'btn small danger';
      remove.textContent = '×';
      remove.title = 'ลบผังห้องนี้';
      remove.addEventListener('click', function () {
        project.rooms.splice(index, 1);
        markDirty();
        renderRooms();
        renderTabs();
      });
      actions.appendChild(remove);
      tr.appendChild(actions);
      body.appendChild(tr);
    });

    $('roomsEmpty').textContent = project.rooms.length
      ? ''
      : 'ยังไม่มีผังห้อง — กด “+ เพิ่มผังห้อง” หรือดึงจากเว็บไซต์ด้านบน';
  }

  function autoPricePerSqm(room, index) {
    if (room.pricePerSqmTHB || !room.priceTHB || !room.sizeSqm) return;
    room.pricePerSqmTHB = Math.round(room.priceTHB / room.sizeSqm);
    var row = $('roomsBody').children[index];
    if (row) row.children[4].querySelector('input').value = room.pricePerSqmTHB;
    markDirty();
  }

  function renderChips() {
    renderChipList('facilityChips', 'facilities');
    renderChipList('promoChips', 'promotions');
  }

  function renderChipList(containerId, key) {
    var project = activeProject();
    var container = $(containerId);
    container.innerHTML = '';
    if (!project || !project[key].length) {
      container.innerHTML = '<span class="faint">ยังไม่มีข้อมูล</span>';
      return;
    }
    project[key].forEach(function (value, index) {
      var chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = esc(value) + ' <button title="ลบ">×</button>';
      chip.querySelector('button').addEventListener('click', function () {
        project[key].splice(index, 1);
        markDirty();
        renderChips();
        renderCompleteness();
      });
      container.appendChild(chip);
    });
  }

  function addChip(inputId, key) {
    var project = activeProject();
    var input = $(inputId);
    var value = input.value.trim();
    if (!project || !value) return;
    if (project[key].indexOf(value) === -1) project[key].push(value);
    input.value = '';
    markDirty();
    renderChips();
    renderCompleteness();
  }

  function renderSources() {
    var project = activeProject();
    var panel = $('sourcesPanel');
    if (!project || !project.sources.length) {
      panel.innerHTML = '';
      return;
    }
    var rows = project.sources.slice().reverse().map(function (source) {
      var when = source.scrapedAt ? new Date(source.scrapedAt).toLocaleString('th-TH') : '—';
      var fields = source.appliedFields.length
        ? source.appliedFields.map(function (f) { return FIELD_LABELS[f] || f; }).join(', ')
        : 'ไม่ได้ใส่ค่าใด';
      return '<li style="margin-bottom:6px"><span class="mono faint">' + esc(when) + '</span> · ' +
        '<a href="' + esc(source.url) + '" target="_blank" rel="noreferrer noopener">' + esc(source.url) + '</a>' +
        '<div class="faint">ใส่ค่า: ' + esc(fields) + '</div></li>';
    }).join('');
    panel.innerHTML =
      '<div class="panel"><h2>ที่มาของข้อมูล</h2>' +
      '<h3>บันทึกไว้ว่าค่าไหนมาจากเว็บไหน ตอนไหน</h3>' +
      '<ul style="list-style:none;padding:0;margin:0;font-size:13px">' + rows + '</ul></div>';
  }

  function renderCompleteness() {
    var project = activeProject();
    var checks = [];
    if (project) {
      var rooms = project.rooms;
      var sized = rooms.filter(function (r) { return r.sizeSqm; });
      checks = [
        { label: 'ชื่อโครงการ', done: !!project.name },
        { label: 'ทำเล', done: !!project.location },
        { label: 'เว็บไซต์โครงการ', done: !!project.website },
        { label: 'ราคาเริ่มต้น', done: !!project.priceStartTHB },
        { label: 'ราคาต่อ ตร.ม.', done: !!project.pricePerSqmTHB },
        { label: 'จำนวนยูนิต', done: !!project.unitsTotal },
        { label: 'มีผังห้องอย่างน้อย 1 ผัง', done: rooms.length > 0 },
        { label: 'ผังห้องมีขนาด ตร.ม. ครบทุกผัง', done: rooms.length > 0 && sized.length === rooms.length },
        { label: 'ผังห้องมีความสูงฝ้าครบทุกผัง', done: rooms.length > 0 && rooms.every(function (r) { return r.ceilingHeightM; }) },
        { label: 'ผังห้องมีราคาครบทุกผัง', done: rooms.length > 0 && rooms.every(function (r) { return r.priceTHB; }) },
        { label: 'สิ่งอำนวยความสะดวกอย่างน้อย 3 อย่าง', done: project.facilities.length >= 3 }
      ];
    }

    var done = checks.filter(function (c) { return c.done; }).length;
    var percent = checks.length ? Math.round((done / checks.length) * 100) : 0;
    $('completenessBar').style.width = percent + '%';
    $('completenessPct').textContent = percent + '%';
    $('completenessSub').textContent = project
      ? project.name + ' · ครบ ' + done + ' จาก ' + checks.length + ' รายการ'
      : 'ยังไม่ได้เลือกโครงการ';
    $('checklist').innerHTML = checks.map(function (check) {
      return '<li class="' + (check.done ? 'done' : '') + '"><b>' + (check.done ? '✓' : '○') + '</b>' +
        esc(check.label) + '</li>';
    }).join('');

    var sizedCount = project ? project.rooms.filter(function (r) { return r.sizeSqm; }).length : 0;
    $('engineStatus').innerHTML = sizedCount
      ? '<div class="callout good"><strong>weakness engine ใช้ข้อมูลนี้พิสูจน์ได้แล้ว</strong>' +
        '<div>มีผังห้องที่ระบุขนาดจริง ' + sizedCount + ' ผัง — exploitability จะไม่ถูกล็อกไว้ที่ 2 อีกต่อไป ' +
        'สำหรับจุดอ่อนที่เทียบขนาดห้องได้</div></div>'
      : '<div class="callout"><strong>ต้องแก้ก่อนถึงจะใช้ได้เต็มที่</strong>' +
        '<div>ยังไม่มีข้อมูลห้องของโครงการนี้ในระบบ — จุดอ่อนทุกข้อจึงถูกล็อก exploitability ไว้ที่ 2 ' +
        'เพราะระบบยังพิสูจน์ไม่ได้ว่าเราชนะจริง</div></div>';
  }

  /* ------------------------------- scraping ------------------------------ */

  async function runScrape(payload, statusText) {
    var status = $('scrapeStatus');
    status.textContent = statusText;
    $('scrapeBtn').disabled = true;
    $('parsePasteBtn').disabled = true;
    try {
      var result = await AsherAPI.scrape(payload);
      state.scrape = result;
      renderScrapeResult(result);
      status.textContent = 'ดึงข้อมูลเสร็จ · อ่านข้อความได้ ' + fmtNumber(result.textLength) + ' ตัวอักษร';
    } catch (err) {
      state.scrape = null;
      $('scrapeResult').hidden = true;
      status.textContent = '';
      toast(err.message, 'err');
    } finally {
      $('scrapeBtn').disabled = false;
      $('parsePasteBtn').disabled = false;
    }
  }

  function isEmptyValue(value) {
    return value === null || value === undefined || value === '';
  }

  /**
   * ติ๊กให้ล่วงหน้าเฉพาะช่องที่ยังว่าง — ค่าที่คนกรอกเองไว้แล้วต้องกดยืนยันเองทุกครั้ง
   * (กันเคสเผลอ scrape เว็บอีกโครงการแล้วชื่อ/ราคาโครงการนี้ถูกทับ)
   */
  function shouldPreselect(currentValue) {
    return isEmptyValue(currentValue);
  }

  function renderScrapeResult(result) {
    var project = activeProject();
    var box = $('scrapeResult');
    var html = '';

    if (result.warnings && result.warnings.length) {
      html += '<div class="callout"><strong>ข้อควรระวัง</strong><div>' +
        result.warnings.map(esc).join('<br>') + '</div></div>';
    }

    html += '<h3 style="margin-top:6px">ค่าที่ระบบเดาได้ — เลือกเฉพาะที่ถูกต้อง</h3>';

    var fieldKeys = Object.keys(result.fields || {});
    if (!fieldKeys.length) {
      html += '<div class="faint" style="margin-bottom:12px">ไม่พบค่าระดับโครงการในหน้านี้</div>';
    }
    fieldKeys.forEach(function (key) {
      var candidate = result.fields[key];
      var current = project ? project[key] : '';
      var checked = shouldPreselect(current) ? ' checked' : '';
      var shown = NUMERIC_FIELDS.indexOf(key) === -1 ? candidate.value : fmtNumber(candidate.value);
      var currentShown = isEmptyValue(current)
        ? '<span class="faint">ยังว่าง</span>'
        : '<span class="dirty-flag">⚠ จะทับค่าเดิม: ' +
          esc(NUMERIC_FIELDS.indexOf(key) === -1 ? current : fmtNumber(current)) + '</span>';
      html +=
        '<div class="scrape-row">' +
          '<input type="checkbox" data-scrape-field="' + esc(key) + '"' + checked + '>' +
          '<div>' +
            '<div class="label">' + esc(FIELD_LABELS[key] || key) +
              ' <span class="confidence ' + esc(candidate.confidence) + '">' +
              esc(CONFIDENCE_LABELS[candidate.confidence]) + '</span></div>' +
            '<div class="value">' + esc(shown) + '</div>' +
            '<div>' + currentShown + '</div>' +
            '<div class="evidence">' + esc(candidate.evidence) + '</div>' +
          '</div>' +
        '</div>';
    });

    if (result.ceilingHeightM) {
      html +=
        '<div class="scrape-row">' +
          '<input type="checkbox" data-scrape-ceiling checked>' +
          '<div>' +
            '<div class="label">ความสูงฝ้า (ใส่ให้ทุกผังห้องที่เลือก) ' +
              '<span class="confidence ' + esc(result.ceilingHeightM.confidence) + '">' +
              esc(CONFIDENCE_LABELS[result.ceilingHeightM.confidence]) + '</span></div>' +
            '<div class="value">' + esc(result.ceilingHeightM.value) + ' ม.</div>' +
            '<div class="evidence">' + esc(result.ceilingHeightM.evidence) + '</div>' +
          '</div>' +
        '</div>';
    }

    html += '<h3 style="margin-top:18px">ผังห้องที่เจอ</h3>';
    if (!result.rooms.length) {
      html += '<div class="faint">ไม่เจอผังห้องในหน้านี้</div>';
    }
    result.rooms.forEach(function (room, index) {
      var existing = project && project.rooms.filter(function (r) {
        return r.type && r.type.toLowerCase() === room.type.toLowerCase();
      })[0];
      var action = existing ? 'อัปเดตผังเดิม' : 'เพิ่มผังใหม่';
      html +=
        '<div class="scrape-row">' +
          '<input type="checkbox" data-scrape-room="' + index + '"' + (room.sizeSqm ? ' checked' : '') + '>' +
          '<div>' +
            '<div class="label">' + esc(action) +
              ' <span class="confidence ' + esc(room.confidence) + '">' +
              esc(CONFIDENCE_LABELS[room.confidence]) + '</span></div>' +
            '<div class="value">' + esc(room.type) +
              ' · ' + (room.sizeSqm ? esc(room.sizeSqm) + ' ตร.ม.' : '<span class="faint">ไม่พบขนาด</span>') +
              (room.priceTHB ? ' · ' + fmtNumber(room.priceTHB) + ' บาท' : '') +
            '</div>' +
            '<div class="evidence">' + esc(room.evidence) + '</div>' +
          '</div>' +
        '</div>';
    });

    if (result.facilities.length) {
      html += '<h3 style="margin-top:18px">สิ่งอำนวยความสะดวกที่เจอ</h3><div class="chips">';
      result.facilities.forEach(function (facility, index) {
        var already = project && project.facilities.indexOf(facility.value) !== -1;
        html += '<label class="chip"><input type="checkbox" data-scrape-facility="' + index + '"' +
          (already ? '' : ' checked') + '> ' + esc(facility.value) +
          (already ? ' <span class="faint">(มีแล้ว)</span>' : '') + '</label>';
      });
      html += '</div>';
    }

    html +=
      '<div class="row" style="margin-top:18px">' +
        '<button class="btn primary" id="applyScrapeBtn">ใส่ค่าที่เลือกลงฟอร์ม</button>' +
        '<button class="btn" id="dismissScrapeBtn">ปิด</button>' +
        '<span class="faint">ที่มา: ' + esc(result.url) + '</span>' +
      '</div>';

    box.innerHTML = html;
    box.hidden = false;
    $('applyScrapeBtn').addEventListener('click', applyScrape);
    $('dismissScrapeBtn').addEventListener('click', function () {
      box.hidden = true;
      state.scrape = null;
    });
  }

  function applyScrape() {
    var project = activeProject();
    var result = state.scrape;
    if (!project || !result) return;
    var box = $('scrapeResult');
    var applied = [];

    box.querySelectorAll('[data-scrape-field]').forEach(function (checkbox) {
      if (!checkbox.checked) return;
      var key = checkbox.dataset.scrapeField;
      project[key] = result.fields[key].value;
      applied.push(key);
    });

    var ceilingBox = box.querySelector('[data-scrape-ceiling]');
    var ceiling = ceilingBox && ceilingBox.checked && result.ceilingHeightM
      ? result.ceilingHeightM.value
      : null;

    box.querySelectorAll('[data-scrape-room]').forEach(function (checkbox) {
      if (!checkbox.checked) return;
      var room = result.rooms[Number(checkbox.dataset.scrapeRoom)];
      var existing = project.rooms.filter(function (r) {
        return r.type && r.type.toLowerCase() === room.type.toLowerCase();
      })[0];
      var target = existing || {
        id: 'room-' + Date.now() + '-' + project.rooms.length,
        type: room.type, sizeSqm: null, ceilingHeightM: null, priceTHB: null,
        pricePerSqmTHB: null, units: null, bedWidthFt: null, usableWidthM: null, notes: ''
      };
      // ไม่ทับค่าที่กรอกเองไว้แล้ว — เติมเฉพาะช่องที่ยังว่าง
      if (room.sizeSqm && !target.sizeSqm) target.sizeSqm = room.sizeSqm;
      if (room.priceTHB && !target.priceTHB) target.priceTHB = room.priceTHB;
      if (ceiling && !target.ceilingHeightM) target.ceilingHeightM = ceiling;
      if (!target.pricePerSqmTHB && target.priceTHB && target.sizeSqm) {
        target.pricePerSqmTHB = Math.round(target.priceTHB / target.sizeSqm);
      }
      if (!existing) project.rooms.push(target);
      applied.push('room:' + room.type);
    });

    box.querySelectorAll('[data-scrape-facility]').forEach(function (checkbox) {
      if (!checkbox.checked) return;
      var facility = result.facilities[Number(checkbox.dataset.scrapeFacility)];
      if (project.facilities.indexOf(facility.value) === -1) {
        project.facilities.push(facility.value);
        applied.push('facility:' + facility.value);
      }
    });

    if (result.url && /^https?:/i.test(result.url) && !project.website) {
      project.website = result.url;
    }
    project.sources.push({
      url: result.url,
      scrapedAt: result.scrapedAt,
      appliedFields: applied
    });

    box.hidden = true;
    state.scrape = null;
    markDirty();
    renderAll();
    toast(applied.length
      ? 'ใส่ค่าลงฟอร์มแล้ว ' + applied.length + ' รายการ — ตรวจแล้วกดบันทึก'
      : 'ไม่ได้เลือกค่าไหนเลย', applied.length ? 'ok' : '');
  }

  /* -------------------------------- บันทึก ------------------------------- */

  async function save() {
    var project = activeProject();
    if (!project) return;
    if (!project.name.trim()) return toast('ต้องมีชื่อโครงการก่อนบันทึก', 'err');

    $('saveBtn').disabled = true;
    try {
      await AsherAPI.saveProject(project);
      AsherAPI.clearDraft(project.id);
      clearDirty();
      toast('บันทึก ' + project.name + ' ลง Local API แล้ว', 'ok');
      renderDraftNotice();
    } catch (err) {
      if (err.offline) {
        state.apiLive = false;
        setBadge('offline', 'LOCAL API · OFFLINE');
        var stored = AsherAPI.saveDraft(project);
        toast(stored
          ? 'API ไม่ทำงาน — เก็บร่างไว้ในเบราว์เซอร์แล้ว เปิด server เมื่อไหร่ค่อยกดซิงก์'
          : 'API ไม่ทำงาน และเก็บร่างในเบราว์เซอร์ไม่ได้ด้วย', 'err');
      } else {
        toast(err.message, 'err');
      }
    } finally {
      $('saveBtn').disabled = false;
    }
  }

  async function removeProject() {
    var project = activeProject();
    if (!project) return;
    if (!window.confirm('ลบโครงการ "' + project.name + '" และข้อมูลห้องทั้งหมด?')) return;
    try {
      await AsherAPI.deleteProject(project.id);
      AsherAPI.clearDraft(project.id);
      toast('ลบ ' + project.name + ' แล้ว', 'ok');
      load();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  /* -------------------------------- events ------------------------------- */

  function bindEvents() {
    bindFormInputs();

    $('scrapeBtn').addEventListener('click', function () {
      var url = $('websiteInput').value.trim();
      if (!url) return toast('ใส่ลิงก์เว็บไซต์ก่อน', 'err');
      var project = activeProject();
      if (project && project.website !== url) {
        project.website = url;
        markDirty();
      }
      runScrape({ url: url }, 'กำลังดึงข้อมูลจาก ' + url + ' …');
    });

    $('pasteToggle').addEventListener('click', function () {
      var box = $('pasteBox');
      box.hidden = !box.hidden;
      if (!box.hidden) $('pasteInput').focus();
    });

    $('parsePasteBtn').addEventListener('click', function () {
      var html = $('pasteInput').value.trim();
      if (!html) return toast('วาง HTML หรือข้อความก่อน', 'err');
      runScrape({ html: html, url: $('websiteInput').value.trim() }, 'กำลังแกะข้อมูลที่วาง …');
    });

    $('addRoomBtn').addEventListener('click', function () {
      var project = activeProject();
      if (!project) return;
      project.rooms.push({
        id: 'room-' + Date.now(), type: '', sizeSqm: null, ceilingHeightM: null,
        priceTHB: null, pricePerSqmTHB: null, units: null, bedWidthFt: null,
        usableWidthM: null, notes: ''
      });
      markDirty();
      renderRooms();
      var rows = $('roomsBody').children;
      if (rows.length) rows[rows.length - 1].querySelector('input').focus();
    });

    $('addFacilityBtn').addEventListener('click', function () { addChip('facilityInput', 'facilities'); });
    $('facilityInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addChip('facilityInput', 'facilities'); }
    });
    $('addPromoBtn').addEventListener('click', function () { addChip('promoInput', 'promotions'); });
    $('promoInput').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); addChip('promoInput', 'promotions'); }
    });

    $('saveBtn').addEventListener('click', save);
    $('deleteBtn').addEventListener('click', removeProject);
    $('reloadBtn').addEventListener('click', function () {
      if (state.dirty && !window.confirm('โหลดใหม่จะทิ้งการแก้ไขที่ยังไม่บันทึก ยืนยันหรือไม่?')) return;
      load(state.activeId);
    });

    document.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        save();
      }
    });

    window.addEventListener('beforeunload', function (event) {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });
  }

  bindEvents();
  load();
})();
