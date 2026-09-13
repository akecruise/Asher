/**
 * ตัวเชื่อม Local API ของ ASHER + สำรองข้อมูลลง localStorage เวลา API ไม่ขึ้น
 *
 * ลำดับการหา base URL: ?api=... > localStorage['asher.apiBase'] > origin เดียวกับหน้าเว็บ
 * ถ้าเปิดไฟล์ตรง ๆ (file://) จะ fallback ไป http://localhost:8000
 *
 * เวลา server เปิด auth ไว้ (ASHER_PASSWORD): ปกติจะใช้ session cookie ที่ได้จากหน้า login
 * ถ้าโดน 401 จะเด้งไปหน้า login ให้เอง — ไม่ต้องเก็บรหัสผ่านไว้ในหน้าเว็บ
 * กรณีเรียกข้ามโดเมน (base คนละ origin) ใส่ token ได้ด้วย ?token=... หรือ AsherAPI.setToken()
 * (token จะถูกเก็บใน localStorage จึงควรใช้เฉพาะเครื่องที่ไว้ใจได้)
 */
(function (global) {
  'use strict';

  var DRAFT_KEY = 'asher.projects.draft.v1';
  var BASE_KEY = 'asher.apiBase';
  var TOKEN_KEY = 'asher.apiToken';
  var LOGIN_PATH = '/modules/login/';

  function resolveBase() {
    var fromQuery = new URLSearchParams(global.location.search).get('api');
    if (fromQuery) {
      try { localStorage.setItem(BASE_KEY, fromQuery); } catch (e) { /* โหมดส่วนตัว */ }
      return fromQuery.replace(/\/$/, '');
    }
    var stored = null;
    try { stored = localStorage.getItem(BASE_KEY); } catch (e) { /* ไม่มีสิทธิ์ ก็ข้าม */ }
    if (stored) return stored.replace(/\/$/, '');
    if (global.location.protocol === 'file:') return 'http://localhost:8000';
    return global.location.origin;
  }

  function resolveToken() {
    var fromQuery = new URLSearchParams(global.location.search).get('token');
    if (fromQuery) {
      try { localStorage.setItem(TOKEN_KEY, fromQuery); } catch (e) { /* โหมดส่วนตัว */ }
      return fromQuery;
    }
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  var base = resolveBase();
  var token = resolveToken();

  function sameOrigin() {
    return !base || base === global.location.origin;
  }

  /** โดน 401 = session หมดอายุหรือยังไม่ได้ login — พากลับไปหน้า login พร้อมจำหน้าเดิมไว้ */
  function goToLogin() {
    if (!sameOrigin()) return;
    var next = global.location.pathname + global.location.search;
    global.location.replace(LOGIN_PATH + '?next=' + encodeURIComponent(next));
  }

  function readDrafts() {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function writeDrafts(drafts) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
      return true;
    } catch (e) {
      return false;
    }
  }

  async function request(path, options) {
    var opts = options || {};
    var init = {
      method: opts.method || 'GET',
      headers: {},
      credentials: sameOrigin() ? 'same-origin' : 'include'
    };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (token) init.headers['x-asher-token'] = token;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, opts.timeout || 30000);
    init.signal = controller.signal;

    var response;
    try {
      response = await fetch(base + path, init);
    } catch (err) {
      clearTimeout(timer);
      var offline = new Error('ต่อ Local API ไม่ได้ — สั่ง `node server/server.js` แล้วลองใหม่');
      offline.offline = true;
      throw offline;
    }
    clearTimeout(timer);

    var payload = null;
    try { payload = await response.json(); } catch (e) { /* ตอบไม่ใช่ JSON */ }
    if (response.status === 401) {
      goToLogin();
      var unauth = new Error('ต้องเข้าสู่ระบบก่อน');
      unauth.unauthorized = true;
      throw unauth;
    }
    if (!response.ok) {
      throw new Error((payload && payload.error) || ('API ตอบกลับ HTTP ' + response.status));
    }
    return payload;
  }

  var AsherAPI = {
    get base() { return base; },

    setBase: function (value) {
      base = String(value || '').replace(/\/$/, '');
      try { localStorage.setItem(BASE_KEY, base); } catch (e) { /* ข้าม */ }
      return base;
    },

    /** ใส่ token สำหรับเรียกข้ามโดเมน (ปกติไม่ต้องใช้ ถ้าเปิดผ่าน origin เดียวกับ server) */
    setToken: function (value) {
      token = String(value || '');
      try {
        if (token) localStorage.setItem(TOKEN_KEY, token);
        else localStorage.removeItem(TOKEN_KEY);
      } catch (e) { /* ข้าม */ }
      return token;
    },

    /** ออกจากระบบ: ล้าง cookie ฝั่ง server + token ที่เก็บไว้ */
    logout: async function () {
      try { await request('/api/session', { method: 'DELETE' }); } catch (e) { /* ข้าม */ }
      this.setToken('');
      if (sameOrigin()) global.location.replace(LOGIN_PATH);
    },

    health: function () {
      return request('/api/health', { timeout: 4000 });
    },

    getProjects: function () {
      return request('/api/asher/projects');
    },

    saveProject: function (project) {
      return request('/api/asher/projects/' + encodeURIComponent(project.id), {
        method: 'PUT',
        body: project
      });
    },

    createProject: function (project) {
      return request('/api/asher/projects', { method: 'POST', body: project });
    },

    deleteProject: function (id) {
      return request('/api/asher/projects/' + encodeURIComponent(id), { method: 'DELETE' });
    },

    scrape: function (payload) {
      return request('/api/scrape', { method: 'POST', body: payload, timeout: 45000 });
    },

    /* ---- คู่แข่ง + weakness engine ---- */

    getCompetitors: function () {
      return request('/api/competitors');
    },

    saveCompetitor: function (project) {
      return request('/api/competitors/' + encodeURIComponent(project.id), {
        method: 'PUT',
        body: project
      });
    },

    /** จุดอ่อนที่สแกนได้ พร้อมสถานะว่าพิสูจน์ด้วยข้อมูลห้อง ASHER แล้วหรือยัง */
    getWeakness: function () {
      return request('/api/weakness');
    },

    /** บันทึกการตัดสินใจ: {id, status?: new|used|dismissed, outcome?: won|lost|noeffect, reset?} */
    setWeaknessAction: function (payload) {
      return request('/api/weakness/actions', { method: 'POST', body: payload });
    },

    seedSampleCompetitor: function () {
      return request('/api/weakness/sample', { method: 'POST' });
    },

    /* ---- ร่างที่ค้างอยู่ในเครื่อง (ใช้ตอน API ล่ม) ---- */

    saveDraft: function (project) {
      var drafts = readDrafts();
      drafts[project.id] = { savedAt: new Date().toISOString(), project: project };
      return writeDrafts(drafts);
    },

    listDrafts: function () {
      var drafts = readDrafts();
      return Object.keys(drafts).map(function (id) {
        return { id: id, savedAt: drafts[id].savedAt, project: drafts[id].project };
      });
    },

    getDraft: function (id) {
      var entry = readDrafts()[id];
      return entry ? entry.project : null;
    },

    clearDraft: function (id) {
      var drafts = readDrafts();
      delete drafts[id];
      writeDrafts(drafts);
    },

    /** ดันร่างที่ค้างทั้งหมดขึ้น API แล้วล้างทิ้ง */
    syncDrafts: async function () {
      var results = { synced: [], failed: [] };
      var drafts = this.listDrafts();
      for (var i = 0; i < drafts.length; i += 1) {
        try {
          await this.saveProject(drafts[i].project);
          this.clearDraft(drafts[i].id);
          results.synced.push(drafts[i].id);
        } catch (err) {
          results.failed.push({ id: drafts[i].id, error: err.message });
        }
      }
      return results;
    }
  };

  global.AsherAPI = AsherAPI;

  /**
   * ผูกปุ่ม "ออกจากระบบ" ให้อัตโนมัติ — หน้าไหนมี [data-asher-logout] ก็ใช้ได้เลย
   * ซ่อนไว้ก่อน แล้วค่อยโชว์เมื่อ server บอกว่าเปิด auth อยู่ (โหมด localhost จะไม่โชว์)
   */
  function wireLogout() {
    var links = document.querySelectorAll('[data-asher-logout]');
    if (!links.length) return;
    for (var i = 0; i < links.length; i += 1) {
      links[i].hidden = true;
      links[i].addEventListener('click', function (event) {
        event.preventDefault();
        AsherAPI.logout();
      });
    }
    request('/api/session', { timeout: 4000 }).then(function (payload) {
      if (!payload || !payload.authRequired) return;
      for (var i = 0; i < links.length; i += 1) links[i].hidden = false;
    }).catch(function () { /* ต่อ API ไม่ได้ ก็ซ่อนไว้อย่างนั้น */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireLogout);
  } else {
    wireLogout();
  }
})(window);
