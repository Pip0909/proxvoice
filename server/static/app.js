'use strict';

const $ = (s) => document.querySelector(s);

let cfg = { maxDistance: 32, iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] };
let audioCtx = null;
let masterGain = null;
let localStream = null;
let localAnalyser = null;
let session = null;
let es = null;
let leaving = false;
let reconnectTimer = null;
let pingTimer = null;
let uiTimer = null;
let wakeLock = null;
let muted = false;
let gameMuted = false;
let callPairs = new Set();
let masterVol = 1;
let deafened = false;
let selfInfo = null;
let adminOpen = false;

// TEMP_STUB - will replace with full file
console.error('ProxVoice app.js is being restored');
