/**
 * หน้า login — แลกรหัสผ่านเป็น session cookie (HttpOnly) แล้วเด้งกลับหน้าที่ขอมา
 * รหัสผ่านไม่ถูกเก็บไว้ใน localStorage ที่ไหนทั้งสิ้น
 */
(function () {
  'use strict';

  var form = document.getElementById('form');
  var input = document.getElementById('password');
  var submit = document.getElementById('submit');
  var errorBox = document.getElementById('error');

  /** ยอมเฉพาะ path ภายในเว็บเดียวกัน กัน open redirect */
  function nextPath() {
    var raw = new URLSearchParams(location.search).get('next') || '';
    if (!raw.startsWith('/') || raw.startsWith('//')) return '/modules/asher-projects/';
    return raw;
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('show');
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    errorBox.classList.remove('show');
    submit.disabled = true;
    submit.textContent = 'กำลังตรวจสอบ…';

    try {
      var response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password: input.value })
      });
      var payload = null;
      try { payload = await response.json(); } catch (e) { /* ไม่ใช่ JSON */ }

      if (response.ok) {
        location.replace(nextPath());
        return;
      }
      showError((payload && payload.error) || ('เข้าสู่ระบบไม่สำเร็จ (HTTP ' + response.status + ')'));
    } catch (err) {
      showError('ต่อ server ไม่ได้ — ลองรีเฟรชหน้านี้อีกครั้ง');
    }

    submit.disabled = false;
    submit.textContent = 'เข้าสู่ระบบ';
    input.select();
  });
})();
