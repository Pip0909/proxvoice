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

function pairKey(a, b) {
  return [String(a).toLowerCase(), String(b).toLowerCase()].sort().join('|');
}

// how should the listener hear this speaker right now?
// returns { mode: 'off' | 'spatial' | 'call', range }
function audibility(me, p) {
  if (!me || !p || p.bot || p.mic === false || me.hear === false) return { mode: 'off' };
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
  setMuted(false);
  show('room');
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
    d.peers.forEach((n) => createPeer(n, true)); // newcomer makes the offers
  });
  mine.addEventListener('positions', (e) => {
    const d = JSON.parse(e.data);
    positions.clear();
    d.players.forEach((p) => positions.set(p.name.toLowerCase(), p));
    callPairs = new Set((d.calls || []).map((c) => pairKey(c[0], c[1])));
    const me = session && positions.get(session.name.toLowerCase());
    const gm = !!me && me.mic === false;
    if (gm !== gameMuted) { gameMuted = gm; setMuted(muted); }
    updateAudio();
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

function setMuted(m) {
  muted = m;
  const off = m || gameMuted;
  if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = !off; });
  $('#muteBtn').classList.toggle('is-muted', off);
  $('#muteBtn').setAttribute('aria-pressed', String(off));
  $('#muteIcon').textContent = off ? '🔇' : '🎙️';
  $('#muteLabel').textContent = gameMuted
    ? 'ไมค์ถูกปิดในเกม'
    : (m ? 'ปิดไมค์อยู่ (แตะเพื่อเปิด)' : 'ไมค์เปิดอยู่');
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
  el.append(dot, info, slider);
  $('#players').append(el);
  const row = { el, dot, nameEl, meta };
  rows.set(key, row);
  return row;
}

function renderUI() {
  if (!session) return;
  const me = positions.get(session.name.toLowerCase());
  $('#status').textContent = me ? 'ในเกม · ' + prettyDim(me.dim) : 'ยังไม่ได้อยู่ในเกม';
  $('#meDot').classList.toggle('speaking', !muted && !gameMuted && localAnalyser && level(localAnalyser) > 0.04);

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
      meta = 'ปิดไมค์ในเกม';
    } else if (me.hear === false) {
      meta = 'คุณปิดหูฟังในเกม';
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
    row.nameEl.textContent = p.name;
    row.meta.textContent = meta;
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
$('#muteBtn').addEventListener('click', () => setMuted(!muted));
$('#masterVol').addEventListener('input', (e) => {
  masterVol = Number(e.target.value) / 100;
  if (masterGain) masterGain.gain.value = masterVol;
});
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'm' && session && document.activeElement.tagName !== 'INPUT') setMuted(!muted);
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
