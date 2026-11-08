'use strict';

const $ = (s) => document.querySelector(s);

let cfg = { maxDistance: 32, iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
let audioCtx = null;
let masterGain = null;
let localStream = null;
let localAnalyser = null;
let session = null; // { token, name }
let es = null;
let leaving = false;
let reconnectTimer = null;
let pingTimer = null;
let uiTimer = null;
let wakeLock = null;
let muted = false;       // user pressed mute in the app
let gameMuted = false;   // mic switched off inside the game (VC addon)
let callPairs = new Set();
let masterVol = 1;
let deafened = false;    // "deafen" in the app: hear nobody (and the mic goes quiet, like Discord)
let selfInfo = null;     // what the server says about me: { admin, range, cap, base, override, locked }
let adminOpen = false;

function pairKey(a, b) {
  return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('|');
}

// how should the listener hear this speaker right now?
// returns { mode: 'off' | 'spatial' | 'call', range }
function audibility(me, p) {
  if (!me || !p || p.bot || p.mic === false || me.hear === false || deafened) return { mode: 'off' };
  if (Number(p.range) < 0) return { mode: 'call' }; // whole world: full volume, any dimension
  if (callPairs.has(pairKey(me.name, p.name))) return { mode: 'call' };
  if (me.dim !== p.dim) return { mode: 'off' };
  const range = Number(p.range) > 0 ? Number(p.range) : cfg.maxDistance;
  const d = Math.hypot(me.x - p.x, me.y - p.y, me.z - p.z);
  return d <= range ? { mode: 'spatial', range } : { mode: 'off', range };
}

const peers = new Map();      // canonical name -> peer
const positions = new Map();  // lowercase name -> { name, x, y, z, ry, dim }
const userVolume = new Map(); // lowercase name -> 0..2
const rows = new Map();       // lowercase name -> row elements

// ---------- helpers ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* ignore */ }
  return { ok: res.ok, status: res.status, data };
}

function level(analyser) {
  const buf = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const d = (buf[i] - 128) / 128;
    sum += d * d;
  }
  return Math.sqrt(sum / buf.length);
}

function prettyDim(dim) {
  const d = String(dim || '').replace('minecraft:', '');
  if (d === 'overworld') return 'โลกปกติ';
  if (d === 'nether') return 'เนเธอร์';
  if (d === 'the_end') return 'ดิเอนด์';
  return d || '-';
}

function showError(msg) { $('#loginError').textContent = msg || ''; }

function show(which) {
  $('#login').hidden = which !== 'login';
  $('#room').hidden = which !== 'room';
  const fp = $('#floatPanel');
  if (fp) fp.hidden = which !== 'room';
  document.body.classList.toggle('in-room', which === 'room');
  if (which === 'room') {
    syncFloatPanel();
    nativeOverlayShow();
  } else {
    nativeOverlayHide();
  }
}

/** Android native mobile voice overlay (draw over other apps). */
function nativeOverlayAvailable() {
  return !!(window.ProxVoiceNative || (window.ProxVoiceOverlay && window.ProxVoiceOverlay.available && window.ProxVoiceOverlay.available()));
}
function nativeRangeLabel() {
  const el = $('#rangeNum') || $('#floatRangeNum');
  return (el && el.textContent) ? el.textContent : '–';
}
function nativeOverlayShow() {
  try {
    const name = (session && session.name) || ($('#meName') && $('#meName').textContent) || '';
    const st = ($('#status') && $('#status').textContent) || 'Connected';
    const range = nativeRangeLabel();
    if (window.ProxVoiceNative) {
      window.ProxVoiceNative.showOverlay(name, st, !!micOff(), !!deafened, range);
    } else if (window.ProxVoiceOverlay && window.ProxVoiceOverlay.show) {
      window.ProxVoiceOverlay.show(name, st, !!micOff(), !!deafened, range);
    }
  } catch (e) { /* not in native shell */ }
}
function nativeOverlayUpdate() {
  try {
    const name = (session && session.name) || ($('#meName') && $('#meName').textContent) || '';
    const st = ($('#status') && $('#status').textContent) || '';
    const range = nativeRangeLabel();
    if (window.ProxVoiceNative) {
      window.ProxVoiceNative.updateOverlay(name, st, !!micOff(), !!deafened, range);
    } else if (window.ProxVoiceOverlay && window.ProxVoiceOverlay.update) {
      window.ProxVoiceOverlay.update(name, st, !!micOff(), !!deafened, range);
    }
  } catch (e) { /* ignore */ }
}
function nativeOverlayHide() {
  try {
    if (window.ProxVoiceNative) window.ProxVoiceNative.hideOverlay();
    else if (window.ProxVoiceOverlay && window.ProxVoiceOverlay.hide) window.ProxVoiceOverlay.hide();
  } catch (e) { /* ignore */ }
}

/** Update the status line under the player's name. */
function updateStatusUI(status, name) {
  const el = $('#status');
  const dot = $('#meDot');
  if (!el) return;
  if (name) {
    $('#meName').textContent = name;
    const fn = $('#floatName');
    if (fn) fn.textContent = name;
  }
  if (status === 'connected') {
    const me = session && positions.get(session.name.toLowerCase());
    const text = me ? ('Connected · ' + prettyDim(me.dim)) : 'Connected';
    el.textContent = text;
    el.classList.remove('waiting');
    el.classList.add('connected');
    if (dot) {
      dot.classList.remove('waiting');
      dot.classList.add('online');
    }
    setFloatStatus(text, 'connected');
  } else if (status === 'waiting') {
    el.textContent = 'Waiting for Minecraft…';
    el.classList.remove('connected');
    el.classList.add('waiting');
    if (dot) {
      dot.classList.remove('online', 'speaking');
      dot.classList.add('waiting');
    }
    setFloatStatus('Waiting for Minecraft…', 'waiting');
  } else if (status === 'reconnecting') {
    el.textContent = 'กำลังเชื่อมต่อใหม่…';
    el.classList.remove('connected');
    el.classList.add('waiting');
    setFloatStatus('กำลังเชื่อมต่อใหม่…', 'waiting');
  } else {
    el.textContent = status || '';
    setFloatStatus(status || '', '');
  }
  nativeOverlayUpdate();
}

function setFloatStatus(text, cls) {
  const fs = $('#floatStatus');
  const fd = $('#floatDot');
  if (fs) {
    fs.textContent = text;
    fs.classList.remove('waiting', 'connected');
    if (cls) fs.classList.add(cls);
  }
  if (fd) {
    fd.classList.remove('waiting', 'online', 'speaking');
    if (cls === 'connected') fd.classList.add('online');
    if (cls === 'waiting') fd.classList.add('waiting');
  }
}

function syncFloatPanel() {
  if (!$('#floatPanel') || $('#floatPanel').hidden) return;
  if (session) {
    const fn = $('#floatName');
    if (fn) fn.textContent = session.name;
  }
  const off = micOff();
  const fMic = $('#floatMic');
  if (fMic) {
    fMic.classList.toggle('is-off', off);
    fMic.setAttribute('aria-pressed', String(off));
    fMic.disabled = gameMuted;
    const ico = $('#floatMicIcon');
    if (ico) ico.textContent = off ? '🔇' : '🎙️';
  }
  const fDeaf = $('#floatDeaf');
  if (fDeaf) {
    fDeaf.classList.toggle('is-off', deafened);
    fDeaf.setAttribute('aria-pressed', String(deafened));
    const ico = $('#floatDeafIcon');
    if (ico) ico.textContent = deafened ? '🔇' : '🎧';
  }
  const meDot = $('#meDot');
  const fDot = $('#floatDot');
  if (meDot && fDot) {
    fDot.classList.toggle('speaking', meDot.classList.contains('speaking'));
  }
  const rn = $('#rangeNum');
  const frn = $('#floatRangeNum');
  if (rn && frn) frn.textContent = rn.textContent;
  const mv = $('#masterVol');
  const fv = $('#floatVol');
  if (mv && fv && document.activeElement !== fv) fv.value = mv.value;
  nativeOverlayUpdate();
}

// ---------- start / leave ----------

async function start() {
  const name = $('#gamertag').value.trim();
  if (!name) { showError('กรอก Gamertag ก่อน'); return; }
  showError('');
  $('#joinBtn').disabled = true;
  leaving = false;

  // must be created synchronously inside the click for iOS/Safari
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AC();
  audioCtx.resume();

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
    }
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    cleanupAudio();
    $('#joinBtn').disabled = false;
    if (e.name === 'InsecureContext') showError('ต้องเปิดผ่าน HTTPS ถึงจะใช้ไมค์ได้');
    else if (e.name === 'NotAllowedError') showError('ต้องกดอนุญาตการใช้ไมโครโฟน');
    else if (e.name === 'NotFoundError') showError('ไม่พบไมโครโฟนในอุปกรณ์นี้');
    else showError('เปิดไมค์ไม่ได้: ' + (e.message || e.name));
    return;
  }

  try {
    const r = await fetch('/api/config');
    if (r.ok) cfg = Object.assign(cfg, await r.json());
  } catch (e) { /* keep defaults */ }

  masterGain = audioCtx.createGain();
  masterGain.gain.value = masterVol;
  masterGain.connect(audioCtx.destination);

  const src = audioCtx.createMediaStreamSource(localStream);
  localAnalyser = audioCtx.createAnalyser();
  localAnalyser.fftSize = 512;
  src.connect(localAnalyser); // not connected to output: no self-echo

  let res;
  try {
    res = await api('/api/join', { name });
  } catch (e) {
    cleanupAudio();
    $('#joinBtn').disabled = false;
    showError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    return;
  }
  if (!res.ok) {
    cleanupAudio();
    $('#joinBtn').disabled = false;
    showError(res.data.message || 'เข้าร่วมไม่สำเร็จ');
    return;
  }

  try { localStorage.setItem('pv_name', name); } catch (e) { /* ignore */ }

  session = { token: res.data.token, name: res.data.name };
  $('#meName').textContent = session.name;
  $('#joinBtn').disabled = false;
  deafened = false;
  setMuted(false);
  show('room');
  // Show Waiting immediately if the player is not yet in Minecraft
  updateStatusUI(res.data.in_game ? 'connected' : 'waiting', res.data.name);
  openEvents();
  startTimers();
  requestWakeLock();
}

function cleanupAudio() {
  if (localStream) localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
  localAnalyser = null;
  masterGain = null;
  if (audioCtx) { try { audioCtx.close(); } catch (e) { /* ignore */ } }
  audioCtx = null;
}

function leave() {
  leaving = true;
  clearTimeout(reconnectTimer);
  stopTimers();
  if (es) { es.close(); es = null; }
  closeAllPeers();
  cleanupAudio();
  positions.clear();
  rows.forEach((r) => r.el.remove());
  rows.clear();
  session = null;
  selfInfo = null;
  deafened = false;
  adminOpen = false;
  $('#adminPanel').hidden = true;
  releaseWakeLock();
  show('login');
}

// ---------- server events ----------

function openEvents() {
  const mine = new EventSource('/events?token=' + encodeURIComponent(session.token));
  es = mine;

  mine.addEventListener('joined', (e) => {
    const d = JSON.parse(e.data);
    if (d.maxDistance) cfg.maxDistance = d.maxDistance;
    $('#connNote').textContent = '';
    // Only create WebRTC peers for sessions that are already confirmed in-game
    (d.peers || []).forEach((n) => createPeer(n, true));
    updateStatusUI(d.in_game ? 'connected' : 'waiting', d.name);
  });
  mine.addEventListener('positions', (e) => {
    const d = JSON.parse(e.data);
    positions.clear();
    d.players.forEach((p) => positions.set(p.name.toLowerCase(), p));
    callPairs = new Set((d.calls || []).map((c) => pairKey(c[0], c[1])));
    selfInfo = d.self || selfInfo;
    const me = session && positions.get(session.name.toLowerCase());
    const gm = !!me && me.mic === false;
    if (gm !== gameMuted) { gameMuted = gm; setMuted(muted); }
    // Keep UI status in sync with presence
    updateStatusUI(me ? 'connected' : 'waiting', session && session.name);
    renderControls();
    updateAudio();
  });
  mine.addEventListener('status', (e) => {
    const d = JSON.parse(e.data);
    if (d.name && session) session.name = d.name;
    updateStatusUI(d.status || (d.in_game ? 'connected' : 'waiting'), d.name);
  });
  mine.addEventListener('peer_joined', (e) => {
    const d = JSON.parse(e.data);
    closePeer(d.name); // drop any stale connection from a previous session
    createPeer(d.name, false);
  });
  mine.addEventListener('peer_left', (e) => {
    closePeer(JSON.parse(e.data).name);
  });
  mine.addEventListener('signal', (e) => {
    const d = JSON.parse(e.data);
    handleSignal(d.from, d.data).catch(() => {});
  });
  mine.onerror = () => {
    if (es !== mine) return;
    mine.close();
    es = null;
    closeAllPeers();
    if (!leaving) scheduleReconnect(0);
  };
}

function scheduleReconnect(delay) {
  clearTimeout(reconnectTimer);
  $('#connNote').textContent = 'ขาดการเชื่อมต่อ กำลังเชื่อมใหม่...';
  updateStatusUI('reconnecting');
  reconnectTimer = setTimeout(reconnect, delay === undefined ? 3000 : delay + 1500);
}

async function reconnect() {
  if (leaving || !session) return;
  try {
    const res = await api('/api/join', { name: session.name });
    if (res.ok) {
      session = { token: res.data.token, name: res.data.name };
      openEvents();
      return;
    }
  } catch (e) { /* retry below */ }
  scheduleReconnect(1500);
}

function startTimers() {
  stopTimers();
  pingTimer = setInterval(async () => {
    if (!session || !es) return;
    try {
      const r = await api('/api/ping', { token: session.token });
      if (!r.ok && !leaving && es) {
        const old = es; es = null; old.close();
        closeAllPeers();
        scheduleReconnect(0);
      }
    } catch (e) { /* network blip: SSE onerror handles it */ }
  }, 8000);
  uiTimer = setInterval(renderUI, 200);
}

function stopTimers() {
  clearInterval(pingTimer);
  clearInterval(uiTimer);
  pingTimer = uiTimer = null;
}

// ---------- WebRTC ----------

function sendSignal(to, data) {
  if (!session) return;
  api('/api/signal', { token: session.token, to, data }).catch(() => {});
}

function createPeer(name, initiator) {
  if (peers.has(name) || !localStream) return peers.get(name);
  const pc = new RTCPeerConnection({ iceServers: cfg.iceServers });
  const peer = { name, pc, pending: [], hasAudio: false };
  peers.set(name, peer);

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(name, { candidate: e.candidate });
  };
  pc.ontrack = (e) => attachRemote(peer, e.streams[0] || new MediaStream([e.track]));
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      // let the next join/peer_joined cycle rebuild it
      peer.hasAudio = false;
    }
  };
  if (initiator) {
    pc.onnegotiationneeded = async () => {
      try {
        await pc.setLocalDescription();
        sendSignal(name, { description: pc.localDescription });
      } catch (e) { /* ignore */ }
    };
  }
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  return peer;
}

async function handleSignal(from, data) {
  if (!data) return;
  const peer = peers.get(from) || createPeer(from, false);
  if (!peer) return;
  const pc = peer.pc;
  if (data.description) {
    await pc.setRemoteDescription(data.description);
    for (const c of peer.pending) await pc.addIceCandidate(c).catch(() => {});
    peer.pending = [];
    if (data.description.type === 'offer') {
      await pc.setLocalDescription();
      sendSignal(from, { description: pc.localDescription });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else peer.pending.push(data.candidate);
  }
}

function attachRemote(peer, stream) {
  if (peer.hasAudio || !audioCtx) return;
  peer.hasAudio = true;
  peer.stream = stream;

  // Chrome only delivers WebRTC audio to Web Audio if the stream is also attached to an element
  peer.el = new Audio();
  peer.el.srcObject = stream;
  peer.el.muted = true;
  peer.el.play().catch(() => {});

  const src = audioCtx.createMediaStreamSource(stream);
  const panner = audioCtx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'linear';
  panner.refDistance = 1.5;
  panner.maxDistance = cfg.maxDistance;
  panner.rolloffFactor = 1;
  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  const callGain = audioCtx.createGain(); // phone call: full volume, no distance
  callGain.gain.value = 0;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;

  src.connect(panner);
  panner.connect(gain);
  gain.connect(masterGain);
  src.connect(callGain);
  callGain.connect(masterGain);
  src.connect(analyser);

  Object.assign(peer, { src, panner, gain, callGain, analyser });
  updateAudio();
}

function closePeer(name) {
  const p = peers.get(name);
  if (!p) return;
  peers.delete(name);
  try { p.pc.close(); } catch (e) { /* ignore */ }
  try { if (p.el) { p.el.srcObject = null; } } catch (e) { /* ignore */ }
  try { if (p.src) p.src.disconnect(); } catch (e) { /* ignore */ }
  try { if (p.panner) p.panner.disconnect(); } catch (e) { /* ignore */ }
  try { if (p.gain) p.gain.disconnect(); } catch (e) { /* ignore */ }
  try { if (p.callGain) p.callGain.disconnect(); } catch (e) { /* ignore */ }
}

function closeAllPeers() {
  Array.from(peers.keys()).forEach(closePeer);
}

// ---------- 3D audio ----------

function setParam(param, value, t) {
  param.setTargetAtTime(value, t, 0.12);
}

function updateAudio() {
  if (!audioCtx || !session) return;
  const me = positions.get(session.name.toLowerCase());
  const t = audioCtx.currentTime;

  if (me) {
    const L = audioCtx.listener;
    const yaw = (me.ry * Math.PI) / 180;
    const fx = -Math.sin(yaw);
    const fz = Math.cos(yaw);
    if (L.positionX) {
      setParam(L.positionX, me.x, t);
      setParam(L.positionY, me.y, t);
      setParam(L.positionZ, me.z, t);
      setParam(L.forwardX, fx, t);
      setParam(L.forwardY, 0, t);
      setParam(L.forwardZ, fz, t);
      setParam(L.upX, 0, t);
      setParam(L.upY, 1, t);
      setParam(L.upZ, 0, t);
    } else {
      L.setPosition(me.x, me.y, me.z);
      L.setOrientation(fx, 0, fz, 0, 1, 0);
    }
  }

  peers.forEach((peer, name) => {
    if (!peer.panner) return;
    const key = name.toLowerCase();
    const pos = positions.get(key);
    const a = audibility(me, pos);
    const vol = userVolume.has(key) ? userVolume.get(key) : 1;
    if (a.mode === 'spatial') {
      peer.panner.maxDistance = Math.max(a.range, 2);
      if (peer.panner.positionX) {
        setParam(peer.panner.positionX, pos.x, t);
        setParam(peer.panner.positionY, pos.y, t);
        setParam(peer.panner.positionZ, pos.z, t);
      } else {
        peer.panner.setPosition(pos.x, pos.y, pos.z);
      }
      setParam(peer.gain.gain, vol, t);
      setParam(peer.callGain.gain, 0, t);
    } else if (a.mode === 'call') {
      setParam(peer.gain.gain, 0, t);
      setParam(peer.callGain.gain, vol, t);
    } else {
      setParam(peer.gain.gain, 0, t);
      setParam(peer.callGain.gain, 0, t);
    }
  });
}

// ---------- UI ----------

function micOff() { return muted || gameMuted || deafened; }

function setMuted(m) {
  muted = m;
  if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = !micOff(); });
  renderControls();
  nativeOverlayUpdate();
}

function setDeafened(d) {
  deafened = d;
  setMuted(muted); // deafening silences the mic as well, like Discord
  updateAudio();
}

// ---------- control bar ----------

function fmtRange(r) { return r < 0 ? '🌍' : String(Math.round(r)); }
function stepFor(v) { return v < 20 ? 2 : v < 100 ? 5 : 25; }

function renderControls() {
  if (!session) return;
  const me = positions.get(session.name.toLowerCase());
  const si = selfInfo;
  const hearOffInGame = !!(me && me.hear === false);
  const smutedMe = !!(me && me.smuted);

  const off = micOff();
  const mic = $('#micBtn');
  mic.classList.toggle('is-off', off);
  mic.setAttribute('aria-pressed', String(off));
  mic.disabled = gameMuted; // the game (or an admin) decides; the button cannot override it
  $('#micIcon').textContent = off ? '🔇' : '🎙️';
  $('#micLabel').textContent = off ? 'ปิดไมค์' : 'ไมค์';

  const deaf = $('#deafBtn');
  deaf.classList.toggle('is-off', deafened || hearOffInGame);
  deaf.setAttribute('aria-pressed', String(deafened));
  $('#deafIcon').textContent = deafened || hearOffInGame ? '🙉' : '🎧';
  $('#deafLabel').textContent = deafened ? 'ปิดหู' : 'หู';

  const box = $('#rangeBox');
  if (si) {
    const r = si.range;
    const max = si.admin ? 1000 : si.cap;
    $('#rangeNum').textContent = fmtRange(r);
    $('#rangeLbl').textContent = si.locked ? '🔒 ล็อก' : (r < 0 ? 'ทั้งโลก' : 'วงไมค์');
    box.classList.toggle('locked', !!si.locked);
    box.classList.toggle('global', r < 0 && !si.locked);
    $('#rangeDown').disabled = !!si.locked || (r >= 0 && r <= 1);
    $('#rangeUp').disabled = !!si.locked || r < 0 || r >= max;
    $('#rangeVal').disabled = !!si.locked;
  }

  const admin = !!(si && si.admin);
  $('#adminBtn').classList.toggle('is-on', admin);
  $('#adminBtn').setAttribute('aria-pressed', String(adminOpen));
  $('#adminPanel').hidden = !adminOpen;
  $('#adminLogin').hidden = admin;
  $('#adminTools').hidden = !admin;
  $('#adminLogout').hidden = !admin;
  if (!admin && si && !si.adminEnabled && !$('#adminErr').textContent) {
    $('#adminErr').textContent = 'เซิร์ฟเวอร์ยังไม่ได้ตั้งรหัสแอดมิน';
  }
  if (admin) {
    $('#globalBtn').setAttribute('aria-pressed', String(si.range < 0));
    $('#globalState').textContent = si.range < 0 ? 'เปิด' : 'ปิด';
    $('#baseVal').textContent = String(Math.round(si.base));
    $('#baseAuto').disabled = !si.override;
  }

  const notes = [];
  if (smutedMe) notes.push('แอดมินปิดไมค์คุณอยู่');
  else if (gameMuted) notes.push('ไมค์ถูกปิดในเกม');
  if (hearOffInGame) notes.push('คุณปิดหูฟังในเกม');
  if (si && si.locked) notes.push('วงไมค์ถูกตั้งโดยแอดมิน');
  const n = $('#notice');
  n.hidden = notes.length === 0;
  n.textContent = notes.join(' · ');
  syncFloatPanel();
}

async function sendRange(value) {
  if (!session) return;
  if (selfInfo) selfInfo.range = value === null ? selfInfo.base : value; // optimistic; the server confirms
  renderControls();
  try { await api('/api/range', { token: session.token, range: value }); } catch (e) { /* resynced by the next positions event */ }
}

/** Mic range steps: … 1 → 2 → 4 → 8 → 16 → 32 → … (×2 / ÷2), min 1 */
function nextPow2Range(r, dir, max) {
  const cur = Math.max(1, Math.round(Number(r) || 1));
  if (dir > 0) {
    let n = 1;
    while (n <= cur && n < max) n *= 2;
    return Math.min(max, n);
  }
  // down: previous power of two (or half if already power of two)
  if (cur <= 1) return 1;
  let n = 1;
  while (n * 2 < cur) n *= 2;
  // if cur is exactly power of 2, go to half; else snap down to n
  if (n * 2 === cur) return Math.max(1, n);
  return Math.max(1, n);
}

function stepRange(dir) {
  const si = selfInfo;
  if (!si || si.locked) return;
  const r = si.range;
  if (r < 0) { if (dir < 0) sendRange(null); return; } // leave "whole world"
  const max = si.admin ? 1000 : si.cap;
  sendRange(nextPow2Range(r, dir, max));
}

async function adminLogin() {
  if (!session) return;
  const pw = $('#adminPw').value;
  if (!pw) { $('#adminErr').textContent = 'กรอกรหัสแอดมิน'; return; }
  $('#adminErr').textContent = '';
  $('#adminPwBtn').disabled = true;
  try {
    const res = await api('/api/admin/login', { token: session.token, password: pw });
    if (res.ok) {
      $('#adminPw').value = '';
      if (selfInfo) selfInfo.admin = true;
    } else {
      $('#adminErr').textContent = res.data.message || 'ปลดล็อกไม่สำเร็จ';
    }
  } catch (e) {
    $('#adminErr').textContent = 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
  }
  $('#adminPwBtn').disabled = false;
  renderControls();
}

function adminAction(action, target, value) {
  if (!session) return;
  api('/api/admin/action', { token: session.token, action, target, value }).catch(() => {});
}

function makeRow(key) {
  const el = document.createElement('li');
  el.className = 'player';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const info = document.createElement('div');
  info.className = 'info';
  const nameEl = document.createElement('div');
  nameEl.className = 'pname';
  const meta = document.createElement('div');
  meta.className = 'pmeta';
  info.append(nameEl, meta);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '200';
  slider.value = String(Math.round((userVolume.has(key) ? userVolume.get(key) : 1) * 100));
  slider.setAttribute('aria-label', 'ระดับเสียงของผู้เล่น');
  slider.addEventListener('input', () => {
    userVolume.set(key, Number(slider.value) / 100);
    updateAudio();
  });
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.hidden = true;
  const muteBtn = document.createElement('button');
  muteBtn.addEventListener('click', () => adminAction('mute', key, !muteBtn.classList.contains('on')));
  const globeBtn = document.createElement('button');
  globeBtn.className = 'globe';
  globeBtn.textContent = '🌍 ทั้งโลก';
  globeBtn.addEventListener('click', () => adminAction('player_range', key, globeBtn.classList.contains('on') ? null : -1));
  const resetBtn = document.createElement('button');
  resetBtn.textContent = '↺ รีเซ็ต';
  resetBtn.addEventListener('click', () => adminAction('reset_player', key));
  actions.append(muteBtn, globeBtn, resetBtn);
  el.append(dot, info, slider, actions);
  $('#players').append(el);
  const row = { el, dot, nameEl, meta, actions, muteBtn, globeBtn };
  rows.set(key, row);
  return row;
}

function renderUI() {
  if (!session) return;
  const me = positions.get(session.name.toLowerCase());
  // Status text is owned by updateStatusUI / positions / status events
  if (me) {
    updateStatusUI('connected', session.name);
  } else {
    updateStatusUI('waiting', session.name);
  }
  $('#meDot').classList.toggle('speaking', !micOff() && localAnalyser && level(localAnalyser) > 0.04);

  const seen = new Set();
  positions.forEach((p, key) => {
    if (key === session.name.toLowerCase() || p.bot) return;
    seen.add(key);
    const row = rows.get(key) || makeRow(key);
    const peer = peers.get(p.name);
    const connected = !!(peer && peer.hasAudio);
    const a = audibility(me, p);
    let meta;
    let near = false;
    if (!connected) {
      meta = 'ยังไม่ได้เปิดแอพเสียง';
    } else if (!me) {
      meta = 'เชื่อมต่อแล้ว';
    } else if (p.mic === false) {
      meta = p.smuted ? 'ถูกแอดมินปิดไมค์' : 'ปิดไมค์ในเกม';
    } else if (me.hear === false) {
      meta = 'คุณปิดหูฟังในเกม';
    } else if (deafened) {
      meta = 'คุณปิดหูอยู่';
    } else if (Number(p.range) < 0) {
      meta = '📣 พูดทั้งโลก';
      near = true;
    } else if (a.mode === 'call') {
      meta = '📞 อยู่ในสาย';
      near = true;
    } else if (me.dim !== p.dim) {
      meta = 'อยู่คนละมิติ';
    } else {
      const d = Math.hypot(me.x - p.x, me.y - p.y, me.z - p.z);
      near = a.mode === 'spatial';
      meta = Math.round(d) + ' บล็อก' + (near ? '' : ' · ไกลเกินไป');
    }
    row.nameEl.textContent = (p.admin || p.op ? '🛡️ ' : '') + p.name;
    row.meta.textContent = meta + (p.op ? ' · OP' : (p.admin ? ' · แอดมิน' : ''));
    row.actions.hidden = !(selfInfo && selfInfo.admin);
    row.muteBtn.classList.toggle('on', !!p.smuted);
    row.muteBtn.textContent = p.smuted ? '🔇 ปิดไมค์อยู่' : '🔇 ปิดไมค์';
    row.globeBtn.classList.toggle('on', !!p.forced && Number(p.range) < 0);
    row.el.classList.toggle('offline', !connected);
    row.el.classList.toggle('near', near);
    row.dot.classList.toggle('speaking', connected && peer.analyser && level(peer.analyser) > 0.04 && near);
  });
  rows.forEach((row, key) => {
    if (!seen.has(key)) { row.el.remove(); rows.delete(key); }
  });
  $('#empty').hidden = seen.size > 0;
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* ignore */ }
}

function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
  wakeLock = null;
}

// ---------- wiring ----------

$('#joinBtn').addEventListener('click', start);
$('#gamertag').addEventListener('keydown', (e) => { if (e.key === 'Enter') start(); });
$('#leaveBtn').addEventListener('click', leave);
$('#micBtn').addEventListener('click', () => {
  if (gameMuted) return;
  if (deafened) setDeafened(false); // like Discord: un-deafen first
  else setMuted(!muted);
});
$('#deafBtn').addEventListener('click', () => setDeafened(!deafened));
$('#rangeDown').addEventListener('click', () => stepRange(-1));
$('#rangeUp').addEventListener('click', () => stepRange(1));
$('#rangeVal').addEventListener('click', () => { if (selfInfo && !selfInfo.locked) sendRange(null); });
$('#adminBtn').addEventListener('click', () => { adminOpen = !adminOpen; renderControls(); });
$('#adminPwBtn').addEventListener('click', adminLogin);
$('#adminPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(); });
$('#adminLogout').addEventListener('click', async () => {
  if (session) await api('/api/admin/logout', { token: session.token }).catch(() => {});
  if (selfInfo) selfInfo.admin = false;
  renderControls();
});
$('#globalBtn').addEventListener('click', () => { if (selfInfo) sendRange(selfInfo.range < 0 ? null : -1); });
$('#baseDown').addEventListener('click', () => {
  if (selfInfo) adminAction('base_range', '', Math.max(2, Math.round(selfInfo.base) - stepFor(selfInfo.base - 1)));
});
$('#baseUp').addEventListener('click', () => {
  if (selfInfo) adminAction('base_range', '', Math.min(1000, Math.round(selfInfo.base) + stepFor(selfInfo.base)));
});
$('#baseAuto').addEventListener('click', () => adminAction('base_range', '', null));
$('#masterVol').addEventListener('input', (e) => {
  masterVol = Number(e.target.value) / 100;
  if (masterGain) masterGain.gain.value = masterVol;
});
document.addEventListener('keydown', (e) => {
  if (!session || document.activeElement.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'm') $('#micBtn').click();
  if (k === 'd') $('#deafBtn').click();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && session) {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    requestWakeLock();
  }
});

try { $('#gamertag').value = localStorage.getItem('pv_name') || ''; } catch (e) { /* ignore */ }

// install as app
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $('#installBtn').hidden = false;
});
$('#installBtn').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null;
  $('#installBtn').hidden = true;
});
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches) {
  $('#iosHint').hidden = false;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------- Discord-style floating panel ----------
(function initFloatPanel() {
  const panel = $('#floatPanel');
  if (!panel) return;

  $('#floatMic')?.addEventListener('click', () => {
    if (gameMuted) return;
    if (deafened) setDeafened(false);
    else setMuted(!muted);
  });
  $('#floatDeaf')?.addEventListener('click', () => setDeafened(!deafened));
  $('#floatLeave')?.addEventListener('click', leave);

  let expanded = false;
  $('#floatExpand')?.addEventListener('click', () => {
    expanded = !expanded;
    const extra = $('#floatExtra');
    if (extra) extra.hidden = !expanded;
    const btn = $('#floatExpand');
    if (btn) btn.setAttribute('aria-pressed', String(expanded));
    const ico = $('#floatExpandIcon');
    if (ico) ico.textContent = expanded ? '▾' : '▴';
  });

  $('#floatVol')?.addEventListener('input', (e) => {
    masterVol = Number(e.target.value) / 100;
    if (masterGain) masterGain.gain.value = masterVol;
    const mv = $('#masterVol');
    if (mv) mv.value = e.target.value;
  });
  $('#floatRangeDown')?.addEventListener('click', () => stepRange(-1));
  $('#floatRangeUp')?.addEventListener('click', () => stepRange(1));

  // Drag to reposition (touch + mouse)
  const handle = $('#floatDrag') || panel;
  let dragging = false;
  let startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function pointerDown(clientX, clientY) {
    dragging = true;
    panel.classList.add('dragging');
    const rect = panel.getBoundingClientRect();
    startX = clientX;
    startY = clientY;
    origLeft = rect.left;
    origTop = rect.top;
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.margin = '0';
    panel.style.width = rect.width + 'px';
  }
  function pointerMove(clientX, clientY) {
    if (!dragging) return;
    const dx = clientX - startX;
    const dy = clientY - startY;
    let nx = origLeft + dx;
    let ny = origTop + dy;
    const maxX = window.innerWidth - panel.offsetWidth - 4;
    const maxY = window.innerHeight - panel.offsetHeight - 4;
    nx = Math.max(4, Math.min(maxX, nx));
    ny = Math.max(4, Math.min(maxY, ny));
    panel.style.left = nx + 'px';
    panel.style.top = ny + 'px';
  }
  function pointerUp() {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
  }

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    pointerDown(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', (e) => pointerMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', pointerUp);

  handle.addEventListener('touchstart', (e) => {
    if (!e.touches[0]) return;
    pointerDown(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!dragging || !e.touches[0]) return;
    pointerMove(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  window.addEventListener('touchend', pointerUp);
})();
