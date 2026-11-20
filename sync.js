/* 乐鱼云端对话自动同步。
 * 会员有效期内：把本机完整对话自动同步到账号云空间（每账号最多 200MB）。
 * 会员到期后 7 天滞纳期：不能上传，但仍可查看、导出；再之后云端自动清理。
 * 本文件独立于主程序，不改动原有压缩脚本，出问题删掉这一行引用即可回退。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'leyu:auth-token';
  var API = 'https://api.leyuchat.live/api/auth';
  var SYNC_INTERVAL = 15000;
  var STATE_INTERVAL = 10000;
  var syncing = false;
  var lastState = null;

  function token() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function api(path, init) {
    var headers = { 'Content-Type': 'application/json' };
    if (token()) headers.Authorization = 'Bearer ' + token();
    return fetch(API + path, Object.assign({ headers: headers, credentials: 'omit' }, init || {})).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { if (d.state) lastState = d.state; throw new Error(d.error || ('请求失败 ' + r.status)); }
        return d;
      });
    });
  }

  function openChatDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('浏览器不支持本地对话库'));
      var req = indexedDB.open('chat-demo');
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打不开本地对话库')); };
    });
  }

  function readSessions(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('sessions', 'readonly');
      var req = tx.objectStore('sessions').getAll();
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error || new Error('读不到本地对话')); };
    });
  }

  function banner() {
    var el = document.getElementById('leyu-cloud-sync');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'leyu-cloud-sync';
    el.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:99999;max-width:330px;' +
      'background:#fff;color:#222;border:1px solid #e6e6e6;border-radius:10px;' +
      'padding:8px 10px;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.10);display:none';
    document.body.appendChild(el);
    return el;
  }

  function render(st) {
    var el = banner();
    if (!st || !token()) { el.style.display = 'none'; return; }
    lastState = st;
    var text = '';
    if (st.member) {
      text = '云端已同步 · 已用 ' + fmtBytes(st.used_bytes) + ' / 200MB · 会员剩 ' + st.days_left + ' 天';
    } else if (st.grace) {
      text = '会员已到期 · 云端保留剩 ' + st.grace_days_left + ' 天，续费后可继续同步';
    } else {
      if (!st.count) { el.style.display = 'none'; return; }
      text = '云端记录保留期已结束';
    }
    var buttons = st.can_export
      ? ' <button type="button" data-act="view" style="margin-left:6px;border:0;background:#f2f2f2;border-radius:6px;padding:2px 7px;cursor:pointer;color:#222">查看</button>' +
        '<button type="button" data-act="export" style="margin-left:4px;border:0;background:#f2f2f2;border-radius:6px;padding:2px 7px;cursor:pointer;color:#222">导出</button>'
      : '';
    el.innerHTML = '<span>' + text + '</span>' + buttons;
    el.style.display = 'block';
    el.onclick = function (e) {
      var act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'view') void openExport();
      if (act === 'export') void downloadExport();
    };
  }

  function fetchExport() {
    return api('/conversations/export');
  }

  function openExport() {
    return fetchExport().then(function (d) {
      var url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }));
      window.open(url, '_blank');
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }).catch(function (e) { console.warn('[乐鱼云同步] 查看失败：' + e.message); });
  }

  function downloadExport() {
    return fetchExport().then(function (d) {
      var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '乐鱼云端聊天记录-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
    }).catch(function (e) { console.warn('[乐鱼云同步] 导出失败：' + e.message); });
  }

  function refreshState() {
    if (!token()) { render(null); return Promise.resolve(null); }
    return api('/conversations/state').then(function (st) { render(st); return st; })
      .catch(function () { render(null); return null; });
  }

  function sync() {
    if (syncing || !token()) return Promise.resolve();
    syncing = true;
    return refreshState().then(function (st) {
      if (!st || !st.can_upload) return null;
      return openChatDB().then(readSessions).then(function (sessions) {
        var conversations = sessions.filter(function (s) { return s && s.id; }).map(function (s) {
          return {
            id: s.id,
            title: s.title || '未命名对话',
            updated_at: Number(s.updatedAt) > 0 ? Number(s.updatedAt) : Date.now(),
            payload: s
          };
        });
        if (!conversations.length) return null;
        return api('/conversations/sync', {
          method: 'POST',
          body: JSON.stringify({ conversations: conversations })
        }).then(function (d) {
          if (d && d.state) render(d.state);
          return d;
        });
      });
    }).catch(function (e) {
      console.warn('[乐鱼云同步] ' + e.message);
    }).then(function () { syncing = false; });
  }

  function start() {
    void refreshState();
    void sync();
    setInterval(function () { void refreshState(); }, STATE_INTERVAL);
    setInterval(function () { void sync(); }, SYNC_INTERVAL);
    window.addEventListener('focus', function () { void sync(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) void sync(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
