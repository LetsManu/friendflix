// SPDX-FileCopyrightText: 2026 Manuel Weißböck
// SPDX-License-Identifier: AGPL-3.0-or-later
// The bundled setup and settings pages. They may call only probe_server, get_settings and set_settings.
(function () {
  'use strict';

  function invoke(cmd, args) {
    var t = window.__TAURI_INTERNALS__;
    if (!t || typeof t.invoke !== 'function') return Promise.reject('The app is not ready. Please try again.');
    return t.invoke(cmd, args || {});
  }

  function show(el, text, kind) {
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function message(err) {
    return typeof err === 'string' && err ? err : 'Something went wrong. Please try again.';
  }

  // address form: probe_server checks it (GET /api/version) and, when it is a FriendFlix server, stores and opens it
  function wireAddress(form, input, button, status, onOk) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var address = input.value.trim();
      if (!address) {
        show(status, 'Enter the address of your FriendFlix server.', 'error');
        input.focus();
        return;
      }
      button.disabled = true;
      show(status, 'Checking ' + address + ' …');
      invoke('probe_server', { address: address }).then(function (ok) {
        show(status, 'Connected to FriendFlix ' + ok.version + '.', 'ok');
        if (onOk) onOk(ok);
      }, function (err) {
        show(status, message(err), 'error');
      }).then(function () {
        button.disabled = false;
      });
    });
  }

  function setup() {
    var input = document.getElementById('address');
    wireAddress(document.getElementById('form'), input, document.getElementById('connect'), document.getElementById('status'));
    input.focus();
  }

  function settings() {
    var status = document.getElementById('status');
    var current = document.getElementById('current');
    var fields = {
      hwdec: document.getElementById('hwdec'),
      startFullscreen: document.getElementById('fullscreen'),
      autostart: document.getElementById('autostart'),
      auto: document.getElementById('updates-auto'),
      ask: document.getElementById('updates-ask')
    };
    var saved = null;

    function render(s) {
      saved = s;
      current.textContent = s.server || 'No server set';
      fields.hwdec.checked = s.hwdec;
      fields.startFullscreen.checked = s.startFullscreen;
      fields.autostart.checked = s.autostart;
      fields.auto.checked = s.updates === 'auto';
      fields.ask.checked = s.updates === 'ask';
    }

    function save() {
      if (!saved) return;
      var next = {
        server: saved.server,
        updates: fields.ask.checked ? 'ask' : 'auto',
        hwdec: fields.hwdec.checked,
        startFullscreen: fields.startFullscreen.checked,
        autostart: fields.autostart.checked
      };
      invoke('set_settings', { settings: next }).then(function (s) {
        render(s);
        show(status, 'Saved.', 'ok');
      }, function (err) {
        render(saved);
        show(status, message(err), 'error');
      });
    }

    ['hwdec', 'startFullscreen', 'autostart', 'auto', 'ask'].forEach(function (k) {
      fields[k].addEventListener('change', save);
    });
    wireAddress(document.getElementById('form'), document.getElementById('address'), document.getElementById('change'),
      document.getElementById('server-status'), function (ok) {
        current.textContent = ok.server;
        if (saved) saved.server = ok.server;
        document.getElementById('address').value = '';
      });
    invoke('get_settings').then(render, function (err) { show(status, message(err), 'error'); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.getAttribute('data-page');
    if (page === 'setup') setup();
    else if (page === 'settings') settings();
  });
})();
