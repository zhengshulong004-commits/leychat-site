/* 乐鱼云端对话自动同步（v2：写入即触发，增量上传）。
 * 会员有效期内：本机对话一有变化（新消息、改标题、删改分支）就在 1 秒左右自动同步到账号云空间。
 * 会员到期后 7 天滞纳期：不能上传，但仍可查看、导出；再之后云端自动清理。
 * 每账号最多 200MB；只上传「自上次同步后有变化」的会话，避免整库重发。
 * 本文件独立于主程序，出问题删掉 index.html 里那一行引用即可回退。
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'leyu:auth-token';
  var API = 'https://api.leyuchat.live/api/auth';
  var DEBOUNCE_MS = 1200;      // 连续写入时合并成一次
  var MIN_GAP_MS = 1500;       // 两次上传的最小间隔，避免边打字边刷
  var STATE_INTERVAL = 15000;  // 只刷右下角容量文字，不传数据
  var FULL_SYNC_INTERVAL = 300000; // 兜底全量校验，5 分钟一次
  var syncing = false;
  var pendingTimer = null;
  var lastSyncAt = 0;
  var lastState = null;
  var sentAt = {};             // id -> 已上传过的 updatedAt

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

  /* 复用同一条数据库连接：手机上每次新开连接会累积，连多了会让主程序自己也存不进去 */
  var dbRef = null;
  function openChatDB() {
    if (dbRef) return Promise.resolve(dbRef);
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('浏览器不支持本地对话库'));
      var req = indexedDB.open('chat-demo');
      req.onsuccess = function () {
        var db = req.result;
        db.onversionchange = function () { try { db.close(); } catch (e) { /* 忽略 */ } dbRef = null; };
        db.onclose = function () { dbRef = null; };
        dbRef = db;
        resolve(db);
      };
      req.onerror = function () { dbRef = null; reject(req.error || new Error('打不开本地对话库')); };
    });
  }

  function readAll(db, store) {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = db.transaction(store, 'readonly').objectStore(store).getAll();
      } catch (e) {
        dbRef = null; // 连接已被浏览器关掉，下次重新开
        return reject(e);
      }
      req.onsuccess = function () { resolve(req.result || []); };
      req.onerror = function () { reject(req.error || new Error('读不到 ' + store)); };
    });
  }

  /* ---- 关键：挂在本地写入动作上。主程序每保存一次会话，就安排一次同步 ---- */
  function hookWrites() {
    try {
      if (!window.IDBObjectStore || IDBObjectStore.prototype.__leyuSyncHooked) return;
      var origPut = IDBObjectStore.prototype.put;
      var origAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.put = function () {
        var out = origPut.apply(this, arguments);
        try { if (this.name === 'sessions') scheduleSync(); } catch (e) { /* 忽略 */ }
        return out;
      };
      IDBObjectStore.prototype.add = function () {
        var out = origAdd.apply(this, arguments);
        try { if (this.name === 'sessions') scheduleSync(); } catch (e) { /* 忽略 */ }
        return out;
      };
      IDBObjectStore.prototype.__leyuSyncHooked = true;
    } catch (e) { /* 挂不上就退回定时同步 */ }
  }

  function scheduleSync() {
    if (!token()) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    var wait = Math.max(DEBOUNCE_MS, MIN_GAP_MS - (Date.now() - lastSyncAt));
    pendingTimer = setTimeout(function () { pendingTimer = null; void sync(); }, wait);
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

  function render(st, busy) {
    var el = banner();
    if (!st || !token()) { el.style.display = 'none'; return; }
    lastState = st;
    // 会员有效期内不显示任何常驻浮标：同步在后台默默进行，权益统一写在会员页卡片里
    if (st.member) { el.style.display = 'none'; el.innerHTML = ''; return; }
    var text = '';
    if (st.grace) {
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

  function fetchExport() { return api('/conversations/export'); }

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

  /* 只在出问题时露一下脸：平时不打扰主界面 */
  function notify(text) {
    var el = banner();
    el.innerHTML = '<span>' + text + '</span>';
    el.style.display = 'block';
    el.onclick = null;
    if (notify._t) clearTimeout(notify._t);
    notify._t = setTimeout(function () { el.style.display = 'none'; el.innerHTML = ''; }, 8000);
  }

  function refreshState() {
    if (!token()) { render(null); return Promise.resolve(null); }
    return api('/conversations/state').then(function (st) { render(st, syncing); return st; })
      .catch(function () { render(null); return null; });
  }

  /* 增量同步：先读轻量的会话摘要判断谁变了，再只取变了的完整会话 */
  function sync() {
    if (syncing || !token()) return Promise.resolve();
    syncing = true;
    var startedAt = Date.now();
    return refreshState().then(function (st) {
      if (!st || !st.can_upload) return null;
      return openChatDB().then(function (db) {
        return Promise.all([
          readAll(db, 'sessionSummaries').catch(function () { return []; }),
          readAll(db, 'sessions')
        ]).then(function (res) {
          var summaries = res[0] || [];
          var sessions = res[1] || [];
          var byId = {};
          for (var i = 0; i < sessions.length; i++) { if (sessions[i] && sessions[i].id) byId[sessions[i].id] = sessions[i]; }

          var changed = [];
          var i2;
          if (summaries.length) {
            for (i2 = 0; i2 < summaries.length; i2++) {
              var s = summaries[i2];
              if (!s || !s.id) continue;
              var ua = Number(s.updatedAt) || 0;
              if (sentAt[s.id] === undefined || ua > sentAt[s.id]) changed.push(s.id);
            }
          } else {
            for (i2 = 0; i2 < sessions.length; i2++) {
              var t = sessions[i2];
              if (!t || !t.id) continue;
              var ub = Number(t.updatedAt) || 0;
              if (sentAt[t.id] === undefined || ub > sentAt[t.id]) changed.push(t.id);
            }
          }
          if (!changed.length) return null;

          var conversations = [];
          for (var k = 0; k < changed.length; k++) {
            var full = byId[changed[k]];
            if (!full) continue; // 摘要还在、正文已删：跳过，等下次全量
            conversations.push({
              id: full.id,
              title: full.title || '未命名对话',
              updated_at: Number(full.updatedAt) > 0 ? Number(full.updatedAt) : Date.now(),
              payload: full
            });
          }
          if (!conversations.length) return null;

          return api('/conversations/sync', {
            method: 'POST',
            body: JSON.stringify({ conversations: conversations })
          }).then(function (d) {
            for (var m = 0; m < conversations.length; m++) sentAt[conversations[m].id] = conversations[m].updated_at;
            if (d && d.state) render(d.state, false);
            return d;
          });
        });
      });
    }).catch(function (e) {
      console.warn('[乐鱼云同步] ' + e.message);
      if (/200MB|空间/.test(e.message || '')) notify('云端空间已满（200MB），旧对话需要先导出或清理');
    }).then(function (r) {
      syncing = false;
      lastSyncAt = startedAt;
      return r;
    });
  }

  /* 登录状态变化（换账号 / 退出）时清空已上传标记，避免把 A 的记录当成已传 */
  function watchToken() {
    var cur = token();
    setInterval(function () {
      var now = token();
      if (now !== cur) { cur = now; sentAt = {}; if (now) { void sync(); } else { render(null); } }
    }, 3000);
  }

  function start() {
    hookWrites();
    void refreshState();
    void sync();
    setInterval(function () { void refreshState(); }, STATE_INTERVAL);
    setInterval(function () { sentAt = {}; void sync(); }, FULL_SYNC_INTERVAL);
    window.addEventListener('focus', function () { void sync(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) void sync(); });
    window.addEventListener('online', function () { void sync(); });
    watchToken();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
