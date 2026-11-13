
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
