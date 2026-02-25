(function () {
  'use strict';

  const config = window.CALL_CONFIG || {};
  const roomId = config.roomId;

  const localVideoEl = document.getElementById('local-video');
  const remoteVideoEl = document.getElementById('remote-video');
  const connectionStatusEl = document.getElementById('connection-status');
  const feedbackEl = document.getElementById('feedback');
  const remotePlaceholderEl = document.getElementById('remote-placeholder');
  const remoteMediaStateEl = document.getElementById('remote-media-state');

  const toggleAudioBtn = document.getElementById('toggle-audio-btn');
  const toggleVideoBtn = document.getElementById('toggle-video-btn');
  const enableAllBtn = document.getElementById('enable-all-btn');
  const leaveBtn = document.getElementById('leave-btn');

  const MEDIA_CONSTRAINTS = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    },
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
      facingMode: 'user'
    }
  };

  const mediaState = {
    audioEnabled: true,
    videoEnabled: true
  };

  let socket = null;
  let peerConnection = null;
  let localStream = null;
  let remoteStream = null;
  let iceConfig = null;
  let hasJoinedRoom = false;
  let isLeaving = false;
  let remoteMediaStatus = {
    audioEnabled: true,
    videoEnabled: true
  };

  if (!roomId) {
    setFeedback('roomId ausente na página. Reabra o link da chamada.', 'danger');
    disableControls();
    return;
  }

  setConnectionStatus('Inicializando', 'secondary');
  bindControls();
  init().catch((error) => {
    handleFatalError(error);
  });

  async function init() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Navegador sem suporte completo para getUserMedia.');
    }

    setFeedback('Solicitando permissões de câmera e microfone...', 'secondary');

    const [fetchedIceConfig, stream] = await Promise.all([fetchIceConfig(), startLocalMedia()]);
    iceConfig = fetchedIceConfig;
    localStream = stream;
    localVideoEl.srcObject = localStream;

    setFeedback('Conectando à sala de atendimento...', 'secondary');
    initSocket();
    updateControlLabels();
    updateRemotePlaceholder();
  }

  async function fetchIceConfig() {
    const response = await fetch(`/api/webrtc/ice-config?roomId=${encodeURIComponent(roomId)}`, {
      method: 'GET',
      cache: 'no-store'
    });

    if (!response.ok) {
      const errorBody = await safeJson(response);
      throw new Error(errorBody.message || 'Não foi possível carregar configuração ICE.');
    }

    return response.json();
  }

  async function startLocalMedia() {
    try {
      return await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
    } catch (error) {
      if (error && error.name === 'NotAllowedError') {
        throw new Error('Permissão negada para câmera/microfone.');
      }
      throw error;
    }
  }

  function initSocket() {
    socket = io({
      transports: ['websocket', 'polling']
    });

    socket.on('connect', () => {
      socket.emit('room:join', { roomId });
      setConnectionStatus('Conectando...', 'warning');
    });

    socket.on('disconnect', (reason) => {
      hasJoinedRoom = false;
      closePeerConnection();
      resetRemoteMedia();

      if (isLeaving) {
        return;
      }

      setConnectionStatus('Desconectado', 'danger');
      setFeedback(`Conexão de sinalização encerrada (${reason}).`, 'warning');
    });

    socket.on('room:joined', async ({ participantCount }) => {
      hasJoinedRoom = true;
      if (participantCount === 1) {
        setConnectionStatus('Aguardando participante', 'secondary');
        setFeedback('Você entrou na sala. Aguardando o participante...', 'secondary');
      } else {
        setConnectionStatus('Sincronizando mídia', 'warning');
        setFeedback('Participante detectado. Iniciando conexão WebRTC...', 'warning');
        await createAndSendOffer();
      }
    });

    socket.on('room:peer-joined', () => {
      setConnectionStatus('Participante conectado', 'success');
      setFeedback('Participante entrou na sala.', 'success');
    });

    socket.on('room:peer-left', () => {
      setConnectionStatus('Aguardando participante', 'secondary');
      setFeedback('Participante saiu da sala.', 'warning');
      closePeerConnection();
      resetRemoteMedia();
    });

    socket.on('room:full', () => {
      setConnectionStatus('Sala cheia', 'danger');
      setFeedback('Esta sala já está com 2 participantes.', 'danger');
      isLeaving = true;

      if (socket && socket.connected) {
        socket.disconnect();
      }

      closePeerConnection();
      stopLocalTracks();
      resetRemoteMedia();
      disableControls();
    });

    socket.on('webrtc:offer', async ({ sdp }) => {
      if (!sdp) {
        return;
      }

      try {
        await ensurePeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('webrtc:answer', { roomId, sdp: answer });
      } catch (error) {
        setFeedback(`Erro ao processar offer: ${error.message}`, 'danger');
      }
    });

    socket.on('webrtc:answer', async ({ sdp }) => {
      if (!sdp || !peerConnection) {
        return;
      }

      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (error) {
        setFeedback(`Erro ao aplicar answer: ${error.message}`, 'danger');
      }
    });

    socket.on('webrtc:ice-candidate', async ({ candidate }) => {
      if (!candidate || !peerConnection) {
        return;
      }

      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        setFeedback(`Erro ao adicionar ICE candidate: ${error.message}`, 'danger');
      }
    });

    socket.on('media:state', ({ audioEnabled, videoEnabled }) => {
      remoteMediaStatus = {
        audioEnabled: Boolean(audioEnabled),
        videoEnabled: Boolean(videoEnabled)
      };
      updateRemoteMediaState();
    });

    socket.on('error', ({ message }) => {
      if (message) {
        setFeedback(message, 'danger');
      }
    });
  }

  async function ensurePeerConnection() {
    if (peerConnection) {
      return peerConnection;
    }

    remoteStream = new MediaStream();
    remoteVideoEl.srcObject = remoteStream;

    peerConnection = new RTCPeerConnection({
      iceServers: iceConfig.iceServers || [],
      iceTransportPolicy: iceConfig.iceTransportPolicy || 'all'
    });

    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => remoteStream.addTrack(track));
      updateRemotePlaceholder();
    };

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socket && socket.connected) {
        socket.emit('webrtc:ice-candidate', {
          roomId,
          candidate: event.candidate
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connected') {
        setConnectionStatus('Chamada ativa', 'success');
        setFeedback('Conexão WebRTC estabelecida.', 'success');
      } else if (peerConnection.connectionState === 'disconnected') {
        setConnectionStatus('Reconectando mídia', 'warning');
        setFeedback('Conexão de mídia interrompida. Tentando recuperar...', 'warning');
      } else if (peerConnection.connectionState === 'failed') {
        setConnectionStatus('Falha na mídia', 'danger');
        setFeedback('Falha na conexão de mídia. Verifique TURN e rede.', 'danger');
      }
    };

    return peerConnection;
  }

  async function createAndSendOffer() {
    if (!socket || !socket.connected || !hasJoinedRoom) {
      return;
    }

    try {
      await ensurePeerConnection();
      if (peerConnection.signalingState !== 'stable') {
        return;
      }

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc:offer', { roomId, sdp: offer });
    } catch (error) {
      setFeedback(`Erro ao criar offer: ${error.message}`, 'danger');
    }
  }

  function bindControls() {
    toggleAudioBtn.addEventListener('click', () => {
      if (!localStream) {
        return;
      }

      mediaState.audioEnabled = !mediaState.audioEnabled;
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = mediaState.audioEnabled;
      });

      updateControlLabels();
      emitMediaState();
    });

    toggleVideoBtn.addEventListener('click', () => {
      if (!localStream) {
        return;
      }

      mediaState.videoEnabled = !mediaState.videoEnabled;
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = mediaState.videoEnabled;
      });

      updateControlLabels();
      emitMediaState();
    });

    enableAllBtn.addEventListener('click', () => {
      if (!localStream) {
        return;
      }

      mediaState.audioEnabled = true;
      mediaState.videoEnabled = true;
      localStream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      localStream.getVideoTracks().forEach((track) => {
        track.enabled = true;
      });

      updateControlLabels();
      emitMediaState();
    });

    leaveBtn.addEventListener('click', () => {
      leaveCall();
    });

    window.addEventListener('beforeunload', () => {
      if (socket && socket.connected && hasJoinedRoom) {
        socket.emit('room:leave', { roomId });
      }
      if (socket) {
        socket.disconnect();
      }
      stopLocalTracks();
      closePeerConnection();
    });
  }

  function emitMediaState() {
    if (!socket || !socket.connected || !hasJoinedRoom) {
      return;
    }

    socket.emit('media:state', {
      roomId,
      audioEnabled: mediaState.audioEnabled,
      videoEnabled: mediaState.videoEnabled
    });
  }

  function updateControlLabels() {
    toggleAudioBtn.textContent = mediaState.audioEnabled ? 'Mic ligado' : 'Mic desligado';
    toggleVideoBtn.textContent = mediaState.videoEnabled ? 'Câmera ligada' : 'Câmera desligada';

    toggleAudioBtn.classList.toggle('active-off', !mediaState.audioEnabled);
    toggleVideoBtn.classList.toggle('active-off', !mediaState.videoEnabled);
  }

  function updateRemoteMediaState() {
    const messages = [];
    if (!remoteMediaStatus.audioEnabled) {
      messages.push('Participante com microfone desligado');
    }
    if (!remoteMediaStatus.videoEnabled) {
      messages.push('Participante com câmera desligada');
    }

    if (messages.length === 0) {
      remoteMediaStateEl.style.display = 'none';
      remoteMediaStateEl.textContent = '';
      return;
    }

    remoteMediaStateEl.style.display = 'inline-block';
    remoteMediaStateEl.textContent = messages.join(' | ');
  }

  function updateRemotePlaceholder() {
    const hasRemoteTracks = Boolean(remoteStream && remoteStream.getTracks().length > 0);
    remotePlaceholderEl.style.display = hasRemoteTracks ? 'none' : 'grid';
  }

  function closePeerConnection() {
    if (!peerConnection) {
      return;
    }

    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  function stopLocalTracks() {
    if (!localStream) {
      return;
    }

    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    localVideoEl.srcObject = null;
  }

  function resetRemoteMedia() {
    if (remoteStream) {
      remoteStream.getTracks().forEach((track) => track.stop());
    }

    remoteStream = null;
    remoteVideoEl.srcObject = null;
    remoteMediaStatus = { audioEnabled: true, videoEnabled: true };
    updateRemoteMediaState();
    updateRemotePlaceholder();
  }

  function leaveCall() {
    if (isLeaving) {
      return;
    }
    isLeaving = true;

    if (socket && socket.connected && hasJoinedRoom) {
      socket.emit('room:leave', { roomId });
    }

    if (socket) {
      socket.disconnect();
    }

    closePeerConnection();
    stopLocalTracks();
    resetRemoteMedia();
    disableControls();

    setConnectionStatus('Sessão encerrada', 'secondary');
    setFeedback('Você saiu da chamada.', 'secondary');
  }

  function disableControls() {
    toggleAudioBtn.disabled = true;
    toggleVideoBtn.disabled = true;
    enableAllBtn.disabled = true;
    leaveBtn.disabled = true;
  }

  function setConnectionStatus(text, bootstrapLevel) {
    connectionStatusEl.className = `badge text-bg-${bootstrapLevel}`;
    connectionStatusEl.textContent = text;
  }

  function setFeedback(message, bootstrapLevel) {
    feedbackEl.className = `alert alert-${bootstrapLevel} mt-3 mb-0 small`;
    feedbackEl.textContent = message;
  }

  function handleFatalError(error) {
    const message = error && error.message ? error.message : 'Erro inesperado ao iniciar chamada.';
    stopLocalTracks();
    resetRemoteMedia();
    setConnectionStatus('Erro na inicialização', 'danger');
    setFeedback(message, 'danger');
    disableControls();
  }

  async function safeJson(response) {
    try {
      return await response.json();
    } catch (error) {
      return {};
    }
  }
})();
