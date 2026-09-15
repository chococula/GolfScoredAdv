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
        return base + '#s=' + enc(p);
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
        const names = Object.keys(p.r || {});
        const rows = p.d.map(date => {
            const yes = names.filter(n => (p.r[n].d || []).includes(date));
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
    function closeModal() { document.getElementById('scheduleModal').classList.add('hidden'); }

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
            <p class="text-[11px] text-slate-500 text-center leading-relaxed">Works without a server: everyone taps their dates and re-shares the link.<br>Open the newest link to see everyone's answers merged.</p>`;
    }

    /* ---------- CREATE ---------- */
    function renderCreate() {
        return header('New Date Poll', 'list') + `
            <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-2">Poll Title</label>
                <input type="text" id="schedTitle" value="${esc(draft.title)}" placeholder="e.g. October Round" oninput="Sched.setTitle(this.value)"
                    class="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500 font-medium">
            </div>
            <div>
                <label class="block text-xs font-semibold uppercase text-slate-400 mb-2">Tee Time</label>
                <div class="grid grid-cols-3 gap-2">
                    ${['morning', 'afternoon', 'any'].map(k => `<button onclick="Sched.setTime('${k}')" class="py-2.5 rounded-xl text-xs font-bold border transition ${draft.time === k ? 'bg-emerald-500/15 border-emerald-500 text-emerald-400' : 'bg-slate-900 border-slate-700 text-slate-400'}">${{ morning: '🌅 Morning', afternoon: '☀️ Afternoon', any: '🕐 Any' }[k]}</button>`).join('')}
                </div>
            </div>
            <div>
                <div class="flex justify-between items-center mb-2">
                    <label class="text-xs font-semibold uppercase text-slate-400">Candidate Dates <span class="text-emerald-400">(${draft.dates.size})</span></label>
                    <button onclick="Sched.pickWeekends()" class="text-[11px] text-emerald-400 font-semibold">+ All weekends this month</button>
                </div>
                ${renderCalendar(calOffset, d => draft.dates.has(d), 'Sched.toggleDraft', null)}
            </div>
            <button onclick="Sched.createPoll()" ${draft.dates.size ? '' : 'disabled'} class="w-full ${draft.dates.size ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950' : 'bg-slate-800 text-slate-500'} font-bold py-3.5 rounded-xl shadow-md transition">Create & Share Link</button>`;
    }

    function renderCalendar(offset, isSel, toggleFn, limitSet) {
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const first = new Date(today.getFullYear(), today.getMonth() + offset, 1);
        const y = first.getFullYear(), m = first.getMonth();
        const days = new Date(y, m + 1, 0).getDate();
        let cells = '';
        for (let i = 0; i < first.getDay(); i++) cells += '<div></div>';
        for (let d = 1; d <= days; d++) {
            const dt = new Date(y, m, d), key = ymd(dt);
            const past = dt < today;
            const allowed = limitSet ? limitSet.has(key) : !past;
            const sel = isSel(key);
            const we = dt.getDay() === 0 || dt.getDay() === 6;
            let cls = 'h-10 rounded-lg text-sm font-semibold flex items-center justify-center transition ';
            if (!allowed) cls += limitSet ? 'text-slate-700' : 'text-slate-700';
            else if (sel) cls += 'bg-emerald-500 text-slate-950 shadow';
            else cls += (we ? 'text-emerald-300/80 ' : 'text-slate-300 ') + 'bg-slate-900 border border-slate-800 hover:border-slate-600';
            cells += `<button ${allowed ? `onclick="${toggleFn}('${key}')"` : 'disabled'} class="${cls}">${d}</button>`;
        }
        const canBack = limitSet ? true : offset > 0;
        return `<div class="bg-slate-900/50 border border-slate-800 rounded-2xl p-3">
            <div class="flex justify-between items-center mb-2 px-1">
                <button onclick="Sched.month(-1)" class="text-slate-400 hover:text-white px-2 ${canBack ? '' : 'opacity-20 pointer-events-none'}">‹</button>
                <div class="text-sm font-bold text-white">${MON[m]} ${y}</div>
                <button onclick="Sched.month(1)" class="text-slate-400 hover:text-white px-2">›</button>
            </div>
            <div class="grid grid-cols-7 gap-1 text-center text-[10px] text-slate-500 font-semibold mb-1">${DOW.map(d => `<div>${d[0]}</div>`).join('')}</div>
            <div class="grid grid-cols-7 gap-1">${cells}</div>
        </div>`;
    }

    /* ---------- POLL (respond + results) ---------- */
    function renderPoll(p) {
        const t = tally(p);
        const myName = localStorage.getItem(LS_NAME) || '';
        const mine = myName && p.r && p.r[myName];
        if (mine && mySel.size === 0 && !mySel._touched) mySel = new Set(mine.d);
        const timeLabel = { morning: '🌅 Morning', afternoon: '☀️ Afternoon', any: '🕐 Any time' }[p.time || 'any'];

        const resultRows = t.rows.slice().sort((a, b) => b.count - a.count || a.date.localeCompare(b.date)).map(r => {
            const best = r.count === t.max && t.max > 0;
            const all = t.names.length && r.count === t.names.length;
            return `<div class="flex items-center gap-3 p-3 rounded-xl border ${best ? 'bg-emerald-500/10 border-emerald-500/40' : 'bg-slate-900 border-slate-800'}">
                <div class="w-24 shrink-0">
                    <div class="text-sm font-bold ${best ? 'text-emerald-400' : 'text-white'}">${fmtShort(r.date)}</div>
                    <div class="text-[10px] text-slate-500">${all ? '✅ Everyone' : best ? '⭐ Best so far' : isWeekend(r.date) ? 'Weekend' : 'Weekday'}</div>
                </div>
                <div class="flex-1 flex flex-wrap gap-1">
                    ${r.yes.map(n => `<span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">${esc(n)}</span>`).join('') || '<span class="text-[10px] text-slate-600">—</span>'}
                </div>
                <div class="text-lg font-black ${best ? 'text-emerald-400' : 'text-slate-400'}">${r.count}<span class="text-[10px] text-slate-500">/${t.names.length}</span></div>
            </div>`;
        }).join('');

        return header(esc(p.t), 'list') + `
            <div class="text-xs text-slate-400 flex items-center gap-3 -mt-2">
                <span>${timeLabel}</span><span>·</span><span>${p.d.length} candidate dates</span><span>·</span><span>${t.names.length} replied</span>
            </div>

            <!-- Respond -->
            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <div class="text-xs font-semibold uppercase text-slate-400">Your availability</div>
                <input type="text" id="schedName" value="${esc(myName)}" placeholder="Your name" oninput="localStorage.setItem('${LS_NAME}', this.value.trim())"
                    class="w-full bg-slate-950 border border-slate-700 rounded-xl px-4 py-2.5 text-white text-sm focus:outline-none focus:border-emerald-500 font-medium">
                <div class="grid grid-cols-2 gap-2">
                    ${p.d.map(d => `<button onclick="Sched.toggleMine('${d}')" class="py-2.5 px-3 rounded-xl text-xs font-bold border text-left transition ${mySel.has(d) ? 'bg-emerald-500/15 border-emerald-500 text-emerald-400' : 'bg-slate-950 border-slate-700 text-slate-400'}">
                        ${mySel.has(d) ? '✓ ' : ''}${fmtShort(d)}</button>`).join('')}
                </div>
                <button onclick="Sched.submitMine()" class="w-full bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-3 rounded-xl shadow-md text-sm">${mine ? 'Update & Share Link' : 'Save & Share Link'}</button>
                <p class="text-[10px] text-slate-500 text-center">Sends the link (with your answer included) to the group chat.</p>
            </div>

            <!-- Results -->
            <div>
                <div class="flex justify-between items-center mb-2">
                    <div class="text-xs font-semibold uppercase text-slate-400">Results</div>
                    <button onclick="Sched.shareSummary('${p.id}')" class="text-[11px] text-emerald-400 font-semibold">📤 Share summary</button>
                </div>
                <div class="space-y-2">${resultRows}</div>
            </div>

            <div class="flex gap-2 pt-1">
                <button onclick="Sched.copyLink('${p.id}')" class="flex-1 bg-slate-800 hover:bg-slate-700 text-white font-bold py-3 rounded-xl text-xs">🔗 Copy link</button>
                <button onclick="Sched.deletePoll('${p.id}')" class="w-1/3 bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/30 text-xs font-bold py-3 rounded-xl">Delete</button>
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
        const m = location.hash.match(/^#s=(.+)$/);
        if (!m) return;
        const p = dec(m[1]);
        history.replaceState(null, '', location.pathname + location.search);
        if (!p || !p.id || !Array.isArray(p.d)) return;
        p.r = p.r || {};
        const merged = mergePoll(p);
        mySel = new Set(); mySel._touched = false;
        openModal('poll', merged.id);
    }

    /* ---------- public API ---------- */
    window.Sched = {
        open(id) { mySel = new Set(); openModal('poll', id); },
        go(v) { view = v; if (v === 'create') { draft = { title: '', dates: new Set(), time: 'any' }; calOffset = 0; } render(); },
        close: closeModal,
        month(d) { calOffset = Math.max(0, calOffset + d); render(); },
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
            polls[p.id] = p; savePolls();
            cur = p.id; view = 'poll'; mySel = new Set(); render();
            share(summaryText(p), pollLink(p));
        },
        toggleMine(d) { mySel._touched = true; mySel.has(d) ? mySel.delete(d) : mySel.add(d); render(); },
        submitMine() {
            const name = (document.getElementById('schedName').value || '').trim();
            if (!name) { toast('Enter your name first'); return; }
            localStorage.setItem(LS_NAME, name);
            const p = polls[cur];
            p.r[name] = { d: [...mySel].sort(), ts: Date.now() };
            savePolls(); render();
            share(summaryText(p), pollLink(p));
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

    window.addEventListener('load', () => { injectUI(); handleHash(); });
    window.addEventListener('hashchange', handleHash);
})();
