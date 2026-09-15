/* TVPC Golf — Schedule Poll (no backend)
 * Organizer picks candidate dates → shares link.
 * Each buddy opens link, taps dates they can play, re-shares link (now containing their answer).
 * Anyone opening the latest link sees the tally + best date. Links merge, so order doesn't matter.
 */
(function () {
    const LS_KEY = 'tvpc_golf_polls';
    const LS_NAME = 'tvpc_golf_my_name';
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    let polls = loadPolls();          // {id: poll}
    let view = 'list';                // list | create | poll
    let cur = null;                   // current poll id
    let draft = { title: '', dates: new Set(), time: 'any' };
    let calOffset = 0;                // months from today shown in create calendar
    let mySel = new Set();            // my selected dates in respond view
    let focusDate = null;             // date tapped in poll calendar (detail panel)
    let pollCal = 0;                  // month offset shown in poll calendar
    let showAll = false;              // expanded ranked list in poll view

    /* ---------- live sync (Firebase Realtime DB, optional) ----------
       If window.SCHED_FIREBASE (firebase-config.js) is present and the SDK loaded,
       polls sync in realtime; links become short (#p=<id>).
       Otherwise falls back to the link-chain mode (#s=<data>).
    */
    let db = null, liveRef = null, liveStatus = 'off'; // off | connecting | live | error
    function initLive() {
        try {
            if (!window.SCHED_FIREBASE || !window.firebase) return;
            if (!firebase.apps.length) firebase.initializeApp(window.SCHED_FIREBASE);
            db = firebase.database();
            liveStatus = 'connecting';
            db.ref('.info/connected').on('value', s => { liveStatus = s.val() ? 'live' : 'connecting'; if (!document.getElementById('scheduleModal')?.classList.contains('hidden')) render(); });
        } catch (e) { console.warn('[sched] live init failed', e); db = null; liveStatus = 'error'; }
    }
    function rKey(name) { return name.replace(/[.#$\[\]\/]/g, '_'); }
    function subscribe(id) {
        unsubscribe();
        if (!db) return;
        liveRef = db.ref('polls/' + id);
        liveRef.on('value', snap => {
            const v = snap.val();
            if (!v || !Array.isArray(v.d)) return;
            v.r = v.r || {};
            mergePoll(v);
            if (view === 'poll' && cur === id) render();
        });
    }
    function unsubscribe() { if (liveRef) { liveRef.off(); liveRef = null; } }
    function pushPoll(p) { if (db) db.ref('polls/' + p.id).update({ id: p.id, t: p.t, d: p.d, time: p.time || 'any', c: p.c || Date.now() }); }
    function pushResponse(id, name, resp) { if (db) db.ref('polls/' + id + '/r/' + rKey(name)).set({ n: name, ...resp }); }

    /* ---------- encoding ---------- */
    function enc(obj) {
        const s = JSON.stringify(obj);
        return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    function dec(str) {
        try {
            let b = str.replace(/-/g, '+').replace(/_/g, '/');
            while (b.length % 4) b += '=';
            return JSON.parse(decodeURIComponent(escape(atob(b))));
        } catch (e) { return null; }
    }
    function loadPolls() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; } }
    function savePolls() { localStorage.setItem(LS_KEY, JSON.stringify(polls)); }
    function uid() { return Math.random().toString(36).slice(2, 8); }
    function pollLink(p) {
        const base = location.origin + location.pathname;
        return db ? base + '#p=' + p.id : base + '#s=' + enc(p);
    }

    /* ---------- date helpers ---------- */
    function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
    function fmtShort(s) { const d = parse(s); return DOW[d.getDay()] + ' ' + MON[d.getMonth()] + ' ' + d.getDate(); }
    function fmtLong(s) { const d = parse(s); return DOW[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }
    function isWeekend(s) { const g = parse(s).getDay(); return g === 0 || g === 6; }

    /* ---------- merge (union of responses, newest wins per person) ---------- */
    function mergePoll(incoming) {
        const local = polls[incoming.id];
        if (!local) { polls[incoming.id] = incoming; savePolls(); return incoming; }
        const merged = { ...local, r: { ...local.r } };
        Object.entries(incoming.r || {}).forEach(([name, resp]) => {
            if (!merged.r[name] || (resp.ts || 0) >= (merged.r[name].ts || 0)) merged.r[name] = resp;
        });
        polls[incoming.id] = merged; savePolls(); return merged;
    }

    /* ---------- tally ---------- */
    function tally(p) {
        const keys = Object.keys(p.r || {});
        const nameOf = k => (p.r[k] && p.r[k].n) || k;
        const names = keys.map(nameOf);
        const rows = p.d.map(date => {
            const yes = keys.filter(k => (p.r[k].d || []).includes(date)).map(nameOf);
            return { date, yes, count: yes.length };
        });
        const max = Math.max(0, ...rows.map(r => r.count));
        return { names, rows, max };
    }

    /* ---------- UI shell ---------- */
    function injectUI() {
        // header button
        const hist = document.getElementById('btnHistory');
        if (hist && !document.getElementById('btnSchedule')) {
            const b = document.createElement('button');
            b.id = 'btnSchedule';
            b.className = 'text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-lg border border-slate-700 font-semibold';
            b.innerHTML = '📅 Schedule';
            b.onclick = () => openModal();
            hist.parentNode.insertBefore(b, hist);
        }
        // modal
        if (!document.getElementById('scheduleModal')) {
            const m = document.createElement('div');
            m.id = 'scheduleModal';
            m.className = 'hidden fixed inset-0 bg-slate-950/95 backdrop-blur-sm z-[60] p-4 flex flex-col overflow-y-auto';
            m.innerHTML = '<div class="space-y-4 max-w-md mx-auto w-full pb-8" id="scheduleBody"></div>';
            document.body.appendChild(m);
        }
    }
    function openModal(v, id) {
        injectUI();
        if (v) view = v;
        if (id) cur = id;
        document.getElementById('scheduleModal').classList.remove('hidden');
        render();
    }
    function closeModal() { unsubscribe(); document.getElementById('scheduleModal').classList.add('hidden'); }

    function header(title, backTo) {
        return `<div class="flex justify-between items-center pt-2">
            <h2 class="text-lg font-bold text-white flex items-center gap-2">
                ${backTo ? `<button onclick="Sched.go('${backTo}')" class="text-slate-400 hover:text-white text-base pr-1">‹</button>` : '<span>📅</span>'} ${title}
            </h2>
            <button onclick="Sched.close()" class="text-slate-400 hover:text-white text-sm bg-slate-800 border border-slate-700 px-3 py-1 rounded-lg">✕ Close</button>
        </div>`;
    }

    function render() {
        const body = document.getElementById('scheduleBody');
        if (view === 'create') body.innerHTML = renderCreate();
        else if (view === 'poll' && polls[cur]) body.innerHTML = renderPoll(polls[cur]);
        else { view = 'list'; body.innerHTML = renderList(); }
    }

    /* ---------- LIST ---------- */
    function renderList() {
        const list = Object.values(polls).sort((a, b) => (b.c || 0) - (a.c || 0));
        const cards = list.length ? list.map(p => {
            const t = tally(p);
            const best = t.rows.filter(r => r.count === t.max && t.max > 0);
            return `<button onclick="Sched.open('${p.id}')" class="w-full text-left bg-slate-900 border border-slate-800 hover:border-emerald-500/40 rounded-2xl p-4 transition">
                <div class="flex justify-between items-start">
                    <div>
                        <div class="font-bold text-white">${esc(p.t)}</div>
                        <div class="text-[11px] text-slate-400 mt-0.5">${p.d.length} dates · ${t.names.length} replied</div>
                    </div>
                    <span class="text-[10px] font-bold px-2 py-1 rounded-lg ${best.length ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' : 'bg-slate-800 text-slate-400 border border-slate-700'}">
                        ${best.length ? '⭐ ' + fmtShort(best[0].date) + (best.length > 1 ? ' +' + (best.length - 1) : '') : 'No replies yet'}
                    </span>
                </div>
            </button>`;
        }).join('') : `<div class="text-center text-slate-500 text-sm py-10 space-y-1">
            <div class="text-3xl">🗓️</div><div>No polls yet.</div><div class="text-xs">Create one and share the link with the group.</div></div>`;

        return header('Find a Tee Date') + `
            <div class="space-y-3">${cards}</div>
            <button onclick="Sched.go('create')" class="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-3.5 rounded-xl shadow-md">+ New Date Poll</button>
            <p class="text-[11px] text-slate-500 text-center leading-relaxed">${db ? '● Live sync on — everyone sees updates instantly.' : 'Works without a server: everyone taps their dates and re-shares the link.<br>Open the newest link to see everyone\'s answers merged.'}</p>`;
    }

    /* ---------- CREATE (calendar first) ---------- */
    function renderCreate() {
        const n = draft.dates.size;
        return header('New Date Poll', 'list') + `
            <p class="text-xs text-slate-400 -mt-2">Tap the days you want to propose. Weekends are highlighted.</p>
            ${renderCalendar({ offset: calOffset, isSel: d => draft.dates.has(d), onTap: 'Sched.toggleDraft', nav: 'Sched.month' })}
            <div class="flex justify-between items-center">
                <span class="text-xs text-slate-400"><span class="text-emerald-400 font-bold">${n}</span> date${n === 1 ? '' : 's'} selected</span>
                <div class="flex gap-3">
                    <button onclick="Sched.pickWeekends()" class="text-[11px] text-emerald-400 font-semibold">+ Weekends</button>
                    ${n ? `<button onclick="Sched.clearDraft()" class="text-[11px] text-slate-500 font-semibold">Clear</button>` : ''}
                </div>
            </div>
            <div class="grid grid-cols-5 gap-2">
                <input type="text" id="schedTitle" value="${esc(draft.title)}" placeholder="Title (optional)" oninput="Sched.setTitle(this.value)"
                    class="col-span-3 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500 font-medium">
                <select onchange="Sched.setTime(this.value)" class="col-span-2 bg-slate-900 border border-slate-700 rounded-xl px-2 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500 font-medium">
                    ${['any', 'morning', 'afternoon'].map(k => `<option value="${k}" ${draft.time === k ? 'selected' : ''}>${{ morning: '🌅 Morning', afternoon: '☀️ Afternoon', any: '🕐 Any time' }[k]}</option>`).join('')}
                </select>
            </div>
            <button onclick="Sched.createPoll()" ${n ? '' : 'disabled'} class="w-full ${n ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950' : 'bg-slate-800 text-slate-500'} font-bold py-3.5 rounded-xl shadow-md transition">Create & Share Link</button>`;
    }

    /* ---------- CALENDAR (shared) ----------
       opts: offset, isSel(key), onTap(fnName), nav(fnName),
             poll (optional) → {candidates:Set, count:{key:n}, total, max, focus}
    */
    function renderCalendar(o) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const first = new Date(today.getFullYear(), today.getMonth() + o.offset, 1);
        const y = first.getFullYear(), m = first.getMonth();
        const days = new Date(y, m + 1, 0).getDate();
        let cells = '';
        for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
        for (let d = 1; d <= days; d++) {
            const dt = new Date(y, m, d), key = ymd(dt);
            const we = dt.getDay() === 0 || dt.getDay() === 6;
            const isToday = key === ymd(today);
            let allowed, cls = 'relative h-11 rounded-xl text-sm font-semibold flex items-center justify-center transition ', inner = String(d);

            if (o.poll) {
                const cand = o.poll.candidates.has(key);
                allowed = cand;
                if (!cand) cls += 'text-slate-700';
                else {
                    const c = o.poll.count[key] || 0, sel = o.isSel(key);
                    const heat = o.poll.total ? c / o.poll.total : 0;
                    const best = c === o.poll.max && c > 0;
                    // heat background by share of group
                    let bg = heat >= 0.99 ? 'bg-emerald-500/40 border-emerald-400' : heat >= 0.5 ? 'bg-emerald-500/20 border-emerald-500/50' : heat > 0 ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-900 border-slate-600 border-dashed';
                    cls += `border ${bg} text-white `;
                    if (sel) cls += 'ring-2 ring-emerald-400 ring-offset-1 ring-offset-slate-950 ';
                    if (o.poll.focus === key) cls += 'scale-105 shadow-lg shadow-emerald-500/20 ';
                    inner = `<span class="${sel ? 'text-emerald-300 font-black' : ''}">${d}</span>` +
                        (c ? `<span class="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-emerald-500 text-slate-950 text-[9px] font-black flex items-center justify-center">${c}</span>` : '') +
                        (best && o.poll.total > 1 ? `<span class="absolute -bottom-1 text-[9px]">⭐</span>` : '') +
                        (sel ? `<span class="absolute bottom-0.5 left-1 text-[8px] text-emerald-300">✓</span>` : '');
                }
            } else {
                allowed = dt >= today;
                const sel = o.isSel(key);
                if (!allowed) cls += 'text-slate-700';
                else if (sel) cls += 'bg-emerald-500 text-slate-950 shadow font-black';
                else cls += (we ? 'text-emerald-300/80 ' : 'text-slate-300 ') + 'bg-slate-900 border border-slate-800 hover:border-slate-600';
            }
            if (isToday) cls += ' outline outline-1 outline-slate-500';
            cells += `<button ${allowed ? `onclick="${o.onTap}('${key}')"` : 'disabled'} class="${cls}">${inner}</button>`;
        }
        return `<div class="bg-slate-900/50 border border-slate-800 rounded-2xl p-3">
            <div class="flex justify-between items-center mb-2 px-1">
                <button onclick="${o.nav}(-1)" class="text-slate-400 hover:text-white px-3 py-1 text-lg">‹</button>
                <div class="text-sm font-bold text-white">${MON[m]} ${y}</div>
                <button onclick="${o.nav}(1)" class="text-slate-400 hover:text-white px-3 py-1 text-lg">›</button>
            </div>
            <div class="grid grid-cols-7 gap-1.5 text-center text-[10px] text-slate-500 font-semibold mb-1">${DOW.map((d, i) => `<div class="${i === 0 || i === 6 ? 'text-emerald-500/70' : ''}">${d[0]}</div>`).join('')}</div>
            <div class="grid grid-cols-7 gap-1.5">${cells}</div>
        </div>`;
    }

    function monthOffsetOf(key) {
        const t = new Date(), d = parse(key);
        return (d.getFullYear() - t.getFullYear()) * 12 + (d.getMonth() - t.getMonth());
    }

    /* ---------- POLL (calendar = the survey) ---------- */
    function renderPoll(p) {
        const t = tally(p);
        const myName = localStorage.getItem(LS_NAME) || '';
        const mine = myName && p.r && (p.r[rKey(myName)] || p.r[myName]);
        if (mine && !mySel._touched) { mySel = new Set(mine.d); mySel._touched = true; }
        const timeLabel = { morning: '🌅 Morning', afternoon: '☀️ Afternoon', any: '🕐 Any time' }[p.time || 'any'];
        const count = {}; t.rows.forEach(r => count[r.date] = r.count);
        const best = t.rows.filter(r => r.count === t.max && t.max > 0);
        const ranked = t.rows.slice().sort((a, b) => b.count - a.count || a.date.localeCompare(b.date));
        const dirty = mine ? JSON.stringify([...mySel].sort()) !== JSON.stringify((mine.d || []).slice().sort()) : mySel.size > 0;

        // focus detail
        let detail = '';
        if (focusDate && p.d.includes(focusDate)) {
            const r = t.rows.find(x => x.date === focusDate);
            const no = t.names.filter(n => !r.yes.includes(n));
            detail = `<div class="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 animate-pop">
                <div class="flex justify-between items-center mb-2">
                    <div class="font-bold text-white text-sm">${fmtLong(focusDate)}</div>
                    <div class="text-xs font-bold ${mySel.has(focusDate) ? 'text-emerald-400' : 'text-slate-500'}">${mySel.has(focusDate) ? '✓ You’re in' : 'Tap again to join'}</div>
                </div>
                <div class="flex flex-wrap gap-1">
                    ${r.yes.map(n => `<span class="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">${esc(n)}</span>`).join('')}
                    ${no.map(n => `<span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-500 border border-slate-700 line-through">${esc(n)}</span>`).join('')}
                    ${!t.names.length ? '<span class="text-[10px] text-slate-600">No replies yet</span>' : ''}
                </div>
            </div>`;
        }

        const bestBanner = best.length ? `<div class="bg-emerald-500/10 border border-emerald-500/30 rounded-2xl px-4 py-3 flex items-center justify-between">
                <div><div class="text-[10px] uppercase font-bold text-emerald-500/80">${t.names.length === best[0].count ? 'Everyone can make it' : 'Best so far'}</div>
                <div class="font-black text-emerald-400">${best.map(r => fmtShort(r.date)).join(' · ')}</div></div>
                <div class="text-2xl font-black text-emerald-400">${best[0].count}<span class="text-xs text-slate-500">/${t.names.length}</span></div>
            </div>` : `<div class="bg-slate-900 border border-slate-800 rounded-2xl px-4 py-3 text-xs text-slate-400 text-center">No replies yet — tap the dates you can play 👇</div>`;

        return header(esc(p.t), 'list') + `
            <div class="flex justify-between items-center -mt-2">
                <div class="text-xs text-slate-400 flex items-center gap-1.5">
                    ${liveStatus === 'live' ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span class="text-emerald-400 font-bold">Live</span><span>·</span>' : liveStatus === 'connecting' ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span><span>·</span>' : ''}
                    ${timeLabel} · ${t.names.length} replied</div>
                <input type="text" id="schedName" value="${esc(myName)}" placeholder="Your name" oninput="localStorage.setItem('${LS_NAME}', this.value.trim())"
                    class="w-32 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-xs text-right focus:outline-none focus:border-emerald-500 font-semibold">
            </div>
            ${bestBanner}
            ${renderCalendar({ offset: pollCal, isSel: d => mySel.has(d), onTap: 'Sched.tapPoll', nav: 'Sched.pollMonth',
                poll: { candidates: new Set(p.d), count, total: t.names.length, max: t.max, focus: focusDate } })}
            <div class="flex items-center justify-center gap-4 text-[10px] text-slate-500">
                <span><span class="inline-block w-3 h-3 rounded ring-2 ring-emerald-400 align-middle mr-1"></span>you</span>
                <span><span class="inline-block w-3 h-3 rounded bg-emerald-500/40 align-middle mr-1"></span>more can play</span>
                <span><span class="inline-block w-3 h-3 rounded border border-dashed border-slate-600 align-middle mr-1"></span>proposed</span>
            </div>
            ${detail}
            <button onclick="Sched.submitMine()" class="w-full ${dirty ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-md' : 'bg-slate-800 text-slate-300'} font-bold py-3.5 rounded-xl transition">
                ${dirty ? (db ? `Save ${mySel.size} date${mySel.size === 1 ? '' : 's'}` : (mine ? 'Update & Share Link' : `Save ${mySel.size} date${mySel.size === 1 ? '' : 's'} & Share Link`)) : '📤 Share Link'}
            </button>
            <button onclick="Sched.toggleAll()" class="w-full text-[11px] text-slate-500 font-semibold py-1">${showAll ? '▲ Hide' : '▼ Show'} all dates ranked</button>
            ${showAll ? `<div class="space-y-1.5">${ranked.map(r => `<button onclick="Sched.focus('${r.date}')" class="w-full flex items-center gap-3 px-3 py-2 rounded-xl border text-left ${r.count === t.max && t.max > 0 ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-slate-900 border-slate-800'}">
                <div class="w-20 shrink-0 text-xs font-bold ${r.count === t.max && t.max > 0 ? 'text-emerald-400' : 'text-white'}">${fmtShort(r.date)}</div>
                <div class="flex-1 text-[10px] text-slate-400 truncate">${r.yes.join(', ') || '—'}</div>
                <div class="text-sm font-black ${r.count === t.max && t.max > 0 ? 'text-emerald-400' : 'text-slate-400'}">${r.count}</div></button>`).join('')}</div>` : ''}
            <div class="flex gap-2 pt-1">
                <button onclick="Sched.copyLink('${p.id}')" class="flex-1 bg-slate-800 hover:bg-slate-700 text-white font-bold py-2.5 rounded-xl text-xs">🔗 Copy link</button>
                <button onclick="Sched.deletePoll('${p.id}')" class="w-1/3 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/30 text-xs font-bold py-2.5 rounded-xl">Delete</button>
            </div>`;
    }

    /* ---------- sharing ---------- */
    async function share(text, url) {
        const full = text + '\n' + url;
        if (navigator.share) {
            try { await navigator.share({ text: full }); return; } catch (e) { if (e.name === 'AbortError') return; }
        }
        try { await navigator.clipboard.writeText(full); toast('Copied! Paste it into the group chat.'); }
        catch (e) { prompt('Copy this link:', full); }
    }
    function summaryText(p) {
        const t = tally(p);
        const best = t.rows.filter(r => r.count === t.max && t.max > 0);
        let s = `⛳ ${p.t}\n`;
        if (t.names.length) {
            s += `${t.names.length} replied: ${t.names.join(', ')}\n`;
            if (best.length) s += `⭐ Best: ${best.map(r => fmtShort(r.date) + ' (' + r.count + '/' + t.names.length + ')').join(', ')}\n`;
        } else s += `Dates: ${p.d.map(fmtShort).join(', ')}\n`;
        s += `Tap the link, pick your dates, and re-share 👇`;
        return s;
    }
    function toast(msg) {
        const el = document.createElement('div');
        el.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 bg-emerald-500 text-slate-950 text-sm font-bold px-4 py-2 rounded-xl shadow-xl z-[70] animate-pop';
        el.textContent = msg; document.body.appendChild(el); setTimeout(() => el.remove(), 2200);
    }
    function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

    /* ---------- incoming link ---------- */
    function handleHash() {
        const pm = location.hash.match(/^#p=([a-z0-9]+)$/i);
        if (pm) {
            history.replaceState(null, '', location.pathname + location.search);
            const id = pm[1];
            if (!polls[id]) polls[id] = { id, t: 'Loading…', d: [], r: {}, c: Date.now() };
            enterPoll(id); openModal('poll', id);
            if (!db) toast('Live sync unavailable — ask for the full link');
            return;
        }
        const m = location.hash.match(/^#s=(.+)$/);
        if (!m) return;
        const p = dec(m[1]);
        history.replaceState(null, '', location.pathname + location.search);
        if (!p || !p.id || !Array.isArray(p.d)) return;
        p.r = p.r || {};
        const merged = mergePoll(p);
        enterPoll(merged.id);
        openModal('poll', merged.id);
    }

    function enterPoll(id) {
        cur = id; mySel = new Set(); mySel._touched = false; focusDate = null; showAll = false;
        const p = polls[id]; pollCal = p && p.d.length ? Math.max(0, monthOffsetOf(p.d[0])) : 0;
        subscribe(id);
    }

    /* ---------- public API ---------- */
    window.Sched = {
        open(id) { enterPoll(id); openModal('poll', id); },
        go(v) { if (v !== 'poll') unsubscribe(); view = v; if (v === 'create') { draft = { title: '', dates: new Set(), time: 'any' }; calOffset = 0; } render(); },
        close: closeModal,
        month(d) { calOffset = Math.max(0, calOffset + d); render(); },
        pollMonth(d) { pollCal += d; render(); },
        clearDraft() { draft.dates.clear(); render(); },
        tapPoll(d) {
            if (focusDate === d) { mySel._touched = true; mySel.has(d) ? mySel.delete(d) : mySel.add(d); }
            else focusDate = d;
            render();
        },
        focus(d) { focusDate = d; pollCal = monthOffsetOf(d); render(); },
        toggleAll() { showAll = !showAll; render(); },
        setTitle(v) { draft.title = v; },
        setTime(v) { draft.time = v; render(); },
        toggleDraft(d) { draft.dates.has(d) ? draft.dates.delete(d) : draft.dates.add(d); render(); },
        pickWeekends() {
            const today = new Date(); today.setHours(0, 0, 0, 0);
            const first = new Date(today.getFullYear(), today.getMonth() + calOffset, 1);
            const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
            for (let d = 1; d <= days; d++) {
                const dt = new Date(first.getFullYear(), first.getMonth(), d);
                if (dt >= today && (dt.getDay() === 0 || dt.getDay() === 6)) draft.dates.add(ymd(dt));
            }
            render();
        },
        createPoll() {
            if (!draft.dates.size) return;
            const p = { id: uid(), t: (draft.title || 'Golf Round').trim(), d: [...draft.dates].sort(), time: draft.time, r: {}, c: Date.now() };
            polls[p.id] = p; savePolls(); pushPoll(p);
            enterPoll(p.id); view = 'poll'; render();
            share(summaryText(p), pollLink(p));
        },
        submitMine() {
            const name = (document.getElementById('schedName').value || '').trim();
            if (!name) { toast('Enter your name first'); return; }
            localStorage.setItem(LS_NAME, name);
            const p = polls[cur];
            const resp = { d: [...mySel].sort(), ts: Date.now() };
            if (p.r[name] && rKey(name) !== name) delete p.r[name];
            p.r[rKey(name)] = { n: name, ...resp };
            savePolls(); pushResponse(p.id, name, resp); render();
            if (db) toast('Saved ✓ everyone sees it live'); else share(summaryText(p), pollLink(p));
        },
        shareSummary(id) { share(summaryText(polls[id]), pollLink(polls[id])); },
        async copyLink(id) {
            try { await navigator.clipboard.writeText(pollLink(polls[id])); toast('Link copied'); }
            catch (e) { prompt('Copy this link:', pollLink(polls[id])); }
        },
        deletePoll(id) {
            if (!confirm('Delete this poll from this device?')) return;
            delete polls[id]; savePolls(); view = 'list'; render();
        }
    };

    window.addEventListener('load', () => { initLive(); injectUI(); handleHash(); });
    window.addEventListener('hashchange', handleHash);
})();
