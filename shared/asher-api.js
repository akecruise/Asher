/**
 * ตัวเชื่อม Local API ของ ASHER + สำรองข้อมูลลง localStorage เวลา API ไม่ขึ้น
 *
 * ลำดับการหา base URL: ?api=... > localStorage['asher.apiBase'] > origin เดียวกับหน้าเว็บ
 * ถ้าเปิดไฟล์ตรง ๆ (file://) จะ fallback ไป http://localhost:8000
 */
(function (global) {
  'use strict';

  var DRAFT_KEY = 'asher.projects.draft.v1';
  var BASE_KEY = 'asher.apiBase';

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

  var base = resolveBase();

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
    var init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
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
})(window);
