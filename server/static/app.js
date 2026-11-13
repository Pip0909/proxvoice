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
  if (selfInfo && Number(selfInfo.range) < 0) return '🌍';
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
  audioCtx.onstatechange = () => { if (audioCtx && session && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); };
  bgPrepare(); // must start inside the click so iOS/Chrome allow the keep-alive audio

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('insecure'), { name: 'InsecureContext' });
    }
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 48000,
        // Chrome / Android extras that improve clarity in game noise
        googEchoCancellation: true,
        googNoiseSuppression: true,
        googAutoGainControl: true,
        googHighpassFilter: true,
        googTypingNoiseDetection: true,
        googNoiseSuppression2: true,
        googAutoGainControl2: true,
      },
    });
    // Hint the encoder this is voice (helps some browsers pick better bitrate/packetization)
    try {
      localStream.getAudioTracks().forEach((t) => {
        if ('contentHint' in t) t.contentHint = 'speech';
      });
    } catch (e) { /* ignore */ }
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
  bgStart();
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
  bgStop();
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
    try { nativeOverlayUpdate(); } catch (e) {}
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
  pingTimer = makeTicker(async () => {
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
  if (pingTimer && pingTimer.stop) pingTimer.stop();
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

  // Soft compressor: reduces harsh peaks / clipping when someone shouts or has high mic gain
  const compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 12;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  const panner = audioCtx.createPanner();
  panner.panningModel = 'HRTF';
  // inverse falls off more naturally for voice than linear
  panner.distanceModel = 'inverse';
  panner.refDistance = 2;
  panner.maxDistance = Math.max(cfg.maxDistance || 32, 8);
  panner.rolloffFactor = 1.2;
  panner.coneInnerAngle = 360;
  panner.coneOuterAngle = 360;
  panner.coneOuterGain = 1;

  const gain = audioCtx.createGain();
  gain.gain.value = 0;
  const callGain = audioCtx.createGain(); // phone call: full volume, no distance
  callGain.gain.value = 0;
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;

  // spatial path: src → compressor → panner → gain → master
  src.connect(compressor);
  compressor.connect(panner);
  panner.connect(gain);
  gain.connect(masterGain);
  // call path (full volume): src → compressor → callGain → master
  compressor.connect(callGain);
  callGain.connect(masterGain);
  src.connect(analyser);

  Object.assign(peer, { src, compressor, panner, gain, callGain, analyser });
  updateAudio();
}

function closePeer(name) {
  const p = peers.get(name);
  if (!p) return;
  peers.delete(name);
  try { p.pc.close(); } catch (e) { /* ignore */ }
  try { if (p.el) { p.el.srcObject = null; } } catch (e) { /* ignore */ }
  try { if (p.src) p.src.disconnect(); } catch (e) { /* ignore */ }
  try { if (p.compressor) p.compressor.disconnect(); } catch (e) { /* ignore */ }
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
    if (L.positionX) {
      setParam(L.positionX, me.x, t);
      setParam(L.positionY, me.y, t);
      setParam(L.positionZ, me.z, t);
      const ry = (me.ry || 0) * Math.PI / 180;
      setParam(L.forwardX, -Math.sin(ry), t);
      setParam(L.forwardY, 0, t);
      setParam(L.forwardZ, -Math.cos(ry), t);
      setParam(L.upX, 0, t);
      setParam(L.upY, 1, t);
      setParam(L.upZ, 0, t);
    } else if (L.setPosition) {
      L.setPosition(me.x, me.y, me.z);
      const ry = (me.ry || 0) * Math.PI / 180;
      L.setOrientation(-Math.sin(ry), 0, -Math.cos(ry), 0, 1, 0);
    }
  }

  peers.forEach((peer) => {
    if (!peer.hasAudio || !peer.gain) return;
    const pos = positions.get(peer.name.toLowerCase());
    const a = audibility(me, pos);
    const uv = userVolume.get(peer.name.toLowerCase());
    const vol = (uv !== undefined ? uv : 1) * (deafened ? 0 : 1);

    if (a.mode === 'spatial' && pos) {
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
