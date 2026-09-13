/* =====================================================================
   TVPC Golf – GPS module
   - Course mapping: stand on each tee / green and tap "Mark here"
   - Live distance to green (front/center/back) during a round
   - Auto hole detection (walks onto next tee → advance)
   - Round track log (breadcrumbs) saved with match history
   Hooks into index.html by wrapping existing globals (startGame, renderHole,
   resumeActiveGame, showResults). No changes needed inside those functions.
   ===================================================================== */
(function () {
    const LS_COURSES = 'tvpc_golf_courses';
    const LS_SETTINGS = 'tvpc_golf_gps_settings';
    const M_TO_YD = 1.09361;
    const TEE_RADIUS_M = 35;      // within this of a tee = "on that tee"
    const MIN_FIX_ACCURACY = 40;  // ignore fixes worse than this (m) for auto-hole

    // ---------- storage ----------
    function loadCourses() { try { return JSON.parse(localStorage.getItem(LS_COURSES) || '[]'); } catch { return []; } }
    function saveCourses(list) { localStorage.setItem(LS_COURSES, JSON.stringify(list)); }
    function loadSettings() { try { return Object.assign({ units: 'yd', autoHole: true, track: true }, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch { return { units: 'yd', autoHole: true, track: true }; } }
    function saveSettings(s) { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); }

    function blankCourse(name) {
        const holes = {};
        for (let h = 1; h <= 18; h++) holes[h] = { tee: null, front: null, center: null, back: null, par: 4 };
        return { id: 'c_' + Date.now(), name, holes, createdAt: Date.now() };
    }

    // ---------- geo math ----------
    function haversine(a, b) {
        if (!a || !b) return null;
        const R = 6371000, toRad = d => d * Math.PI / 180;
        const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(s));
    }
    function fmtDist(m) {
        if (m == null) return '--';
        return settings.units === 'yd' ? Math.round(m * M_TO_YD) : Math.round(m);
    }
    function unitLabel() { return settings.units === 'yd' ? 'yd' : 'm'; }

    // ---------- runtime ----------
    let settings = loadSettings();
    let watchId = null;
    let lastFix = null;      // {lat,lng,acc,ts}
    let activeCourse = null;
    let track = [];          // breadcrumbs for this round
    let lastTrackTs = 0;
    let suggestedHole = null;

    function startWatch() {
        if (!('geolocation' in navigator)) { setStatus('GPS not available on this device'); return; }
        if (watchId !== null) return;
        setStatus('Locating…');
        watchId = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
    }
    function stopWatch() {
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    function onErr(e) {
        const msg = { 1: 'Location permission denied – enable it in browser settings', 2: 'No GPS signal', 3: 'GPS timeout – retrying' }[e.code] || 'GPS error';
        setStatus(msg);
    }
    function onFix(pos) {
        lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, ts: pos.timestamp };
        // breadcrumb every 10s while in game
        if (settings.track && inGame() && pos.timestamp - lastTrackTs > 10000) {
            track.push({ h: window.state.currentHole, lat: +lastFix.lat.toFixed(6), lng: +lastFix.lng.toFixed(6), t: pos.timestamp });
            lastTrackTs = pos.timestamp;
            if (window.state) { window.state.gpsTrack = track; }
        }
        renderGpsCard();
        renderMapper();
        checkAutoHole();
    }
    function inGame() { return !document.getElementById('gameScreen').classList.contains('hidden'); }

    // ---------- auto hole ----------
    function checkAutoHole() {
        if (!settings.autoHole || !activeCourse || !lastFix || !inGame()) return;
        if (lastFix.acc > MIN_FIX_ACCURACY) return;
        const cur = window.state.currentHole;
        const next = cur + 1;
        if (next > 18) return;
        const nextTee = activeCourse.holes[next]?.tee;
        if (!nextTee) return;
        const d = haversine(lastFix, nextTee);
        if (d <= TEE_RADIUS_M && suggestedHole !== next) {
            suggestedHole = next;
            showAutoPrompt(next);
        }
    }
    function showAutoPrompt(h) {
        const el = document.getElementById('gpsAutoPrompt');
        el.innerHTML = `
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-emerald-300">📍 You're on the tee of <b>hole ${h}</b></span>
            <div class="flex gap-1.5">
              <button onclick="gps.dismissAuto()" class="text-[11px] px-2 py-1 rounded-lg bg-slate-800 text-slate-300 border border-slate-700">Stay</button>
              <button onclick="gps.acceptAuto(${h})" class="text-[11px] px-2.5 py-1 rounded-lg bg-emerald-500 text-slate-950 font-bold">Go to ${h} ➔</button>
            </div>
          </div>`;
        el.classList.remove('hidden');
        if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    }
    function dismissAuto() { document.getElementById('gpsAutoPrompt').classList.add('hidden'); }
    function acceptAuto(h) {
        dismissAuto();
        window.state.currentHole = h;
        window.saveCurrentGameState();
        window.renderHole();
    }

    // ---------- game-screen card ----------
    function injectGameCard() {
        if (document.getElementById('gpsCard')) return;
        const anchor = document.getElementById('multiplierBanner').closest('.bg-slate-900');
        const card = document.createElement('div');
        card.id = 'gpsCard';
        card.className = 'bg-slate-900 border border-slate-800 rounded-2xl p-3';
        card.innerHTML = `
          <div id="gpsAutoPrompt" class="hidden mb-2 p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30"></div>
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-semibold text-slate-400" id="gpsCourseName">No course selected</span>
            <div class="flex gap-1">
              <button onclick="gps.toggleUnits()" id="gpsUnitBtn" class="text-[11px] px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700">yd</button>
              <button onclick="gps.openMapper()" class="text-[11px] px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700">Map holes</button>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-2 text-center" id="gpsDistances">
            <div class="rounded-xl bg-slate-800/60 py-2"><div class="text-[10px] text-slate-400">Front</div><div class="text-xl font-black text-slate-200" id="gpsFront">--</div></div>
            <div class="rounded-xl bg-emerald-500/10 border border-emerald-500/30 py-2"><div class="text-[10px] text-emerald-400">Center</div><div class="text-3xl font-black text-emerald-400 leading-none" id="gpsCenter">--</div></div>
            <div class="rounded-xl bg-slate-800/60 py-2"><div class="text-[10px] text-slate-400">Back</div><div class="text-xl font-black text-slate-200" id="gpsBack">--</div></div>
          </div>
          <div class="flex justify-between items-center mt-2 text-[11px] text-slate-500">
            <span id="gpsStatus">GPS off</span>
            <span id="gpsHoleMeta"></span>
          </div>`;
        anchor.insertAdjacentElement('afterend', card);
    }
    function setStatus(t) { const el = document.getElementById('gpsStatus'); if (el) el.innerText = t; }

    function renderGpsCard() {
        if (!document.getElementById('gpsCard')) return;
        document.getElementById('gpsUnitBtn').innerText = unitLabel();
        document.getElementById('gpsCourseName').innerText = activeCourse ? activeCourse.name : 'No course selected';
        const h = window.state?.currentHole;
        const hole = activeCourse?.holes?.[h];
        const set = (id, pt) => document.getElementById(id).innerText = (lastFix && pt) ? fmtDist(haversine(lastFix, pt)) : '--';
        set('gpsFront', hole?.front); set('gpsCenter', hole?.center); set('gpsBack', hole?.back);
        document.getElementById('gpsHoleMeta').innerText = hole ? `Par ${hole.par}${hole.tee && hole.center ? ' · ' + fmtDist(haversine(hole.tee, hole.center)) + unitLabel() : ''}` : '';
        if (lastFix) setStatus(`GPS ±${Math.round(lastFix.acc)}m${settings.track ? ' · tracking' : ''}`);
        else if (!activeCourse) setStatus('Pick a course to see distances');
    }
    function toggleUnits() { settings.units = settings.units === 'yd' ? 'm' : 'yd'; saveSettings(settings); renderGpsCard(); renderMapper(); }

    // ---------- setup-screen course picker ----------
    function injectSetupPicker() {
        if (document.getElementById('gpsSetupBlock')) return;
        const titleBlock = document.getElementById('gameTitleInput').parentElement;
        const block = document.createElement('div');
        block.id = 'gpsSetupBlock';
        block.innerHTML = `
          <label class="block text-xs font-semibold uppercase text-slate-400 mb-2">Course (GPS)</label>
          <div class="flex gap-2">
            <select id="courseSelect" class="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-3 text-white focus:outline-none focus:border-emerald-500 text-sm"></select>
            <button onclick="gps.openMapper()" class="px-3 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-sm font-semibold">⚙️</button>
          </div>
          <div class="flex items-center gap-4 mt-2 text-xs text-slate-400">
            <label class="flex items-center gap-1.5"><input type="checkbox" id="gpsAutoHoleChk" class="accent-emerald-500"> Auto hole detect</label>
            <label class="flex items-center gap-1.5"><input type="checkbox" id="gpsTrackChk" class="accent-emerald-500"> Record track</label>
          </div>`;
        titleBlock.insertAdjacentElement('afterend', block);
        document.getElementById('gpsAutoHoleChk').checked = settings.autoHole;
        document.getElementById('gpsTrackChk').checked = settings.track;
        document.getElementById('gpsAutoHoleChk').onchange = e => { settings.autoHole = e.target.checked; saveSettings(settings); };
        document.getElementById('gpsTrackChk').onchange = e => { settings.track = e.target.checked; saveSettings(settings); };
        refreshCourseSelect();
    }
    function refreshCourseSelect() {
        const sel = document.getElementById('courseSelect');
        if (!sel) return;
        const courses = loadCourses();
        const prev = sel.value || localStorage.getItem('tvpc_golf_last_course') || '';
        sel.innerHTML = `<option value="">No GPS (points only)</option>` +
            courses.map(c => `<option value="${c.id}">${c.name} (${mappedCount(c)}/18 mapped)</option>`).join('') +
            `<option value="__new">＋ New course…</option>`;
        sel.value = courses.some(c => c.id === prev) ? prev : '';
        sel.onchange = () => {
            if (sel.value === '__new') { sel.value = ''; createCourse(); }
        };
    }
    function mappedCount(c) { return Object.values(c.holes).filter(h => h.center).length; }
    function createCourse() {
        const name = prompt('Course name (e.g., Poppy Ridge – Merlot/Zinfandel)');
        if (!name) return;
        const c = blankCourse(name.trim());
        const list = loadCourses(); list.push(c); saveCourses(list);
        refreshCourseSelect();
        document.getElementById('courseSelect').value = c.id;
        openMapper(c.id);
    }

    // ---------- mapper modal ----------
    let mapperCourseId = null, mapperHole = 1;
    function injectMapper() {
        if (document.getElementById('gpsMapperModal')) return;
        const m = document.createElement('div');
        m.id = 'gpsMapperModal';
        m.className = 'hidden fixed inset-0 bg-slate-950/95 backdrop-blur-sm z-[60] p-4 flex flex-col overflow-y-auto';
        m.innerHTML = `
          <div class="max-w-md mx-auto w-full flex-1 flex flex-col">
            <div class="flex justify-between items-center mb-3">
              <div class="flex items-center gap-2">
                <select id="mapperCourseSel" class="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm max-w-[200px]"></select>
                <button onclick="gps.renameCourse()" class="text-slate-400 text-xs">✏️</button>
              </div>
              <button onclick="gps.closeMapper()" class="text-slate-400 text-sm">✕ Close</button>
            </div>

            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4 mb-3">
              <div class="flex justify-between items-center">
                <button onclick="gps.mapperNav(-1)" class="px-3 py-1 bg-slate-800 rounded-lg border border-slate-700 text-xs text-slate-300">❮</button>
                <div class="text-center">
                  <div class="text-emerald-400 font-black text-2xl" id="mapperHoleTxt">HOLE 1</div>
                  <div class="text-[11px] text-slate-400">Par
                    <select id="mapperPar" class="bg-slate-800 rounded px-1 text-slate-200"><option>3</option><option>4</option><option>5</option></select>
                  </div>
                </div>
                <button onclick="gps.mapperNav(1)" class="px-3 py-1 bg-slate-800 rounded-lg border border-slate-700 text-xs text-slate-300">❯</button>
              </div>
              <div class="mt-3 text-[11px] text-center text-slate-500" id="mapperFix">Waiting for GPS…</div>
            </div>

            <div class="space-y-2" id="mapperPoints"></div>

            <p class="text-[11px] text-slate-500 mt-3 leading-relaxed">
              Walk to each spot and tap <b>Mark here</b>. Front/back are optional — center is enough for distances,
              tee is needed for auto hole detection. Or long-press a value to type coordinates from Google Maps.
            </p>

            <div class="mt-auto pt-4 grid grid-cols-3 gap-2">
              <button onclick="gps.exportCourse()" class="py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold">Export JSON</button>
              <button onclick="gps.importCourse()" class="py-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 text-xs font-semibold">Import JSON</button>
              <button onclick="gps.deleteCourse()" class="py-2.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-semibold">Delete</button>
            </div>
          </div>`;
        document.body.appendChild(m);
        document.getElementById('mapperPar').onchange = e => { const c = getMapperCourse(); if (c) { c.holes[mapperHole].par = parseInt(e.target.value); persistMapper(c); } };
    }
    function getMapperCourse() { return loadCourses().find(c => c.id === mapperCourseId) || null; }
    function persistMapper(c) { const list = loadCourses().map(x => x.id === c.id ? c : x); saveCourses(list); if (activeCourse && activeCourse.id === c.id) activeCourse = c; refreshCourseSelect(); }

    function openMapper(courseId) {
        injectMapper();
        const courses = loadCourses();
        if (!courses.length) { createCourse(); return; }
        mapperCourseId = courseId || document.getElementById('courseSelect')?.value || activeCourse?.id || courses[0].id;
        if (!courses.some(c => c.id === mapperCourseId)) mapperCourseId = courses[0].id;
        mapperHole = window.state?.currentHole || 1;
        const sel = document.getElementById('mapperCourseSel');
        sel.innerHTML = courses.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
        sel.value = mapperCourseId;
        sel.onchange = () => { mapperCourseId = sel.value; renderMapper(); };
        document.getElementById('gpsMapperModal').classList.remove('hidden');
        startWatch();
        renderMapper();
    }
    function closeMapper() {
        document.getElementById('gpsMapperModal').classList.add('hidden');
        if (!inGame()) stopWatch();
        refreshCourseSelect();
    }
    function mapperNav(d) { mapperHole = Math.min(18, Math.max(1, mapperHole + d)); renderMapper(); }

    function renderMapper() {
        const modal = document.getElementById('gpsMapperModal');
        if (!modal || modal.classList.contains('hidden')) return;
        const c = getMapperCourse(); if (!c) return;
        const hole = c.holes[mapperHole];
        document.getElementById('mapperHoleTxt').innerText = `HOLE ${mapperHole}`;
        document.getElementById('mapperPar').value = hole.par;
        document.getElementById('mapperFix').innerText = lastFix ? `GPS fix ±${Math.round(lastFix.acc)}m · ${lastFix.lat.toFixed(5)}, ${lastFix.lng.toFixed(5)}` : 'Waiting for GPS…';
        const pts = [['tee', 'Tee box'], ['front', 'Green front'], ['center', 'Green center'], ['back', 'Green back']];
        document.getElementById('mapperPoints').innerHTML = pts.map(([k, label]) => {
            const p = hole[k];
            const dist = (p && lastFix) ? `${fmtDist(haversine(lastFix, p))}${unitLabel()} away` : '';
            return `<div class="flex items-center justify-between bg-slate-900 border ${p ? 'border-emerald-500/30' : 'border-slate-800'} rounded-xl px-3 py-2.5">
                <div>
                  <div class="text-sm font-semibold ${p ? 'text-emerald-400' : 'text-slate-300'}">${p ? '✓ ' : ''}${label}</div>
                  <div class="text-[11px] text-slate-500 select-none" oncontextmenu="event.preventDefault(); gps.manualPoint('${k}')" ontouchstart="gps._lp=setTimeout(()=>gps.manualPoint('${k}'),600)" ontouchend="clearTimeout(gps._lp)">${p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : 'not set'} ${dist ? '· ' + dist : ''}</div>
                </div>
                <div class="flex gap-1.5">
                  ${p ? `<button onclick="gps.clearPoint('${k}')" class="text-[11px] px-2 py-1.5 rounded-lg bg-slate-800 text-slate-400 border border-slate-700">✕</button>` : ''}
                  <button onclick="gps.markPoint('${k}')" ${lastFix ? '' : 'disabled'} class="text-[11px] px-2.5 py-1.5 rounded-lg bg-emerald-500 text-slate-950 font-bold disabled:opacity-40">Mark here</button>
                </div>
              </div>`;
        }).join('');
    }
    function markPoint(k) {
        const c = getMapperCourse(); if (!c || !lastFix) return;
        if (lastFix.acc > 25 && !confirm(`GPS accuracy is ±${Math.round(lastFix.acc)}m. Mark anyway?`)) return;
        c.holes[mapperHole][k] = { lat: lastFix.lat, lng: lastFix.lng };
        persistMapper(c); renderMapper(); renderGpsCard();
        if (navigator.vibrate) navigator.vibrate(40);
    }
    function clearPoint(k) { const c = getMapperCourse(); if (!c) return; c.holes[mapperHole][k] = null; persistMapper(c); renderMapper(); renderGpsCard(); }
    function manualPoint(k) {
        const c = getMapperCourse(); if (!c) return;
        const cur = c.holes[mapperHole][k];
        const s = prompt('Paste coordinates as "lat, lng" (from Google Maps right-click)', cur ? `${cur.lat}, ${cur.lng}` : '');
        if (!s) return;
        const m = s.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
        if (!m) { alert('Could not parse. Use: 37.7123, -121.9012'); return; }
        c.holes[mapperHole][k] = { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
        persistMapper(c); renderMapper(); renderGpsCard();
    }
    function renameCourse() { const c = getMapperCourse(); if (!c) return; const n = prompt('Course name', c.name); if (n) { c.name = n.trim(); persistMapper(c); openMapper(c.id); } }
    function deleteCourse() {
        const c = getMapperCourse(); if (!c) return;
        if (!confirm(`Delete "${c.name}" and all its hole data?`)) return;
        saveCourses(loadCourses().filter(x => x.id !== c.id));
        if (activeCourse?.id === c.id) activeCourse = null;
        const left = loadCourses();
        if (left.length) openMapper(left[0].id); else closeMapper();
        refreshCourseSelect(); renderGpsCard();
    }
    async function exportCourse() {
        const c = getMapperCourse(); if (!c) return;
        const json = JSON.stringify(c, null, 2);
        const file = new File([json], `${c.name.replace(/[^\w-]+/g, '_')}.json`, { type: 'application/json' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: c.name }); return; } catch { } }
        try { await navigator.clipboard.writeText(json); alert('Course JSON copied to clipboard'); }
        catch { prompt('Copy this JSON:', json); }
    }
    function importCourse() {
        const s = prompt('Paste course JSON (from another phone\'s Export)');
        if (!s) return;
        try {
            const c = JSON.parse(s);
            if (!c.holes || !c.name) throw 0;
            c.id = 'c_' + Date.now();
            const list = loadCourses(); list.push(c); saveCourses(list);
            refreshCourseSelect(); openMapper(c.id);
        } catch { alert('Invalid course JSON'); }
    }

    // ---------- hook into existing app ----------
    function activateCourseFromState() {
        const id = window.state?.courseId;
        activeCourse = id ? (loadCourses().find(c => c.id === id) || null) : null;
    }
    function wrap(name, before, after) {
        const orig = window[name];
        if (typeof orig !== 'function') return;
        window[name] = function (...args) { before && before(...args); const r = orig.apply(this, args); after && after(...args); return r; };
    }

    window.addEventListener('load', () => {
        injectSetupPicker();
        injectGameCard();
        injectMapper();

        wrap('startGame', null, () => {
            if (document.getElementById('setupScreen').classList.contains('hidden')) { // game actually started
                const id = document.getElementById('courseSelect').value;
                window.state.courseId = id || null;
                localStorage.setItem('tvpc_golf_last_course', id || '');
                track = []; lastTrackTs = 0; suggestedHole = null;
                window.state.gpsTrack = track;
                window.saveCurrentGameState();
                activateCourseFromState();
                if (activeCourse) startWatch(); else stopWatch();
                renderGpsCard();
            }
        });
        wrap('resumeActiveGame', null, () => {
            activateCourseFromState();
            track = Array.isArray(window.state.gpsTrack) ? window.state.gpsTrack : [];
            if (activeCourse) startWatch();
            renderGpsCard();
        });
        wrap('renderHole', null, () => { suggestedHole = null; dismissAuto(); renderGpsCard(); });
        wrap('showResults', () => {
            // attach track summary to state so history keeps it
            if (track.length) {
                window.state.gpsSummary = { course: activeCourse?.name || null, points: track.length, start: track[0].t, end: track[track.length - 1].t };
            }
        }, () => { stopWatch(); });
        wrap('saveMatchToHistory', null, () => {
            // append gps info to the most recent history record
            try {
                const list = JSON.parse(localStorage.getItem('tvpc_golf_history') || '[]');
                if (list.length && window.state.gpsSummary) {
                    const rec = list[0]; // history uses unshift → newest first
                    rec.gps = { ...window.state.gpsSummary, track: track };
                    localStorage.setItem('tvpc_golf_history', JSON.stringify(list));
                }
            } catch { }
        });
        wrap('showSetupScreen', null, () => { stopWatch(); refreshCourseSelect(); });
    });

    window.gps = { openMapper, closeMapper, mapperNav, markPoint, clearPoint, manualPoint, renameCourse, deleteCourse, exportCourse, importCourse, toggleUnits, acceptAuto, dismissAuto, createCourse };
})();
