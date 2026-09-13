/**
 * หน้า login — แลกรหัสผ่านเป็น session cookie (HttpOnly) แล้วเด้งกลับหน้าที่ขอมา
 * รหัสผ่านไม่ถูกเก็บไว้ใน localStorage ที่ไหนทั้งสิ้น
 */
(function () {
  'use strict';

  var form = document.getElementById('form');
  var input = document.getElementById('password');
  var email = document.getElementById('email');
  var emailRow = document.getElementById('emailRow');
  var submit = document.getElementById('submit');
  var errorBox = document.getElementById('error');
  var mode = 'password';

  /**
   * ถาม server ว่าตอนนี้เป็นโหมดไหน
   *   users    -> มีผู้ใช้ในระบบ ต้องกรอกอีเมลด้วย
   *   password -> รหัสผ่านเดียว (ASHER_PASSWORD) ไม่ต้องกรอกอีเมล
   */
  fetch('/api/session', { credentials: 'same-origin' })
    .then(function (res) { return res.json(); })
    .then(function (payload) {
      mode = (payload && payload.mode) || 'password';
      if (mode !== 'users') return;
      emailRow.hidden = false;
      email.required = true;
      email.focus();
    })
    .catch(function () { /* ต่อไม่ได้ ก็ปล่อยเป็นโหมดรหัสผ่านเดียวไปก่อน */ });

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
        body: JSON.stringify({
          email: mode === 'users' ? email.value.trim() : '',
          password: input.value
        })
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
