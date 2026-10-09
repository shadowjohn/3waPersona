import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const $ = id => document.getElementById(id);
const vowels = ['aa', 'ih', 'ou', 'ee', 'oh'];
const faceKeys = ['happy', 'relaxed', 'sad', 'surprised', 'angry'];
const mouth = Object.fromEntries(vowels.map(k => [k, 0]));
const face = Object.fromEntries(faceKeys.map(k => [k, 0]));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = x => { x = clamp(x); return x * x * (3 - 2 * x); };
const approach = (a, b, dt, speed) => a + (b - a) * (1 - Math.exp(-dt * speed));
let renderer, scene, camera, vrm, head, neck, chest, restHead, restNeck;
let audioContext, analyser, frequency, source, playStarted = 0, activeSpeech = null;
let playing = false, busy = false, generationId = 0, pendingRequest = null;
let elapsed = 0, lastFrame = 0, poseTime = 0, nextBlink = 2.1 + Math.random(), blinkAt = -10;
let nextGaze = 1.5, gaze = { x: 0, y: 0 }, gazeGoal = { x: 0, y: 0 };
let envelope = [], envelopeReference = .07, modelReady = false;
const gazeTarget = new THREE.Object3D();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reducedMotion) $('expressions').checked = false;

function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
function updateButtons() {
  $('speak').disabled = !modelReady || busy || playing;
  $('stop').disabled = !busy && !playing;
  $('speak').querySelector('span').textContent = busy ? '準備聲音中…' : '開始說話';
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    pendingRequest = xhr;
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 65000;
    xhr.onload = () => {
      let response;
      try { response = JSON.parse(xhr.responseText); }
      catch { reject(new Error('語音服務回應格式有誤。')); return; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(response);
      else reject(new Error(typeof response.detail === 'string' ? response.detail : '請確認文字與設定後重試。'));
    };
    xhr.onerror = () => reject(new Error('無法連上本機語音服務。'));
    xhr.ontimeout = () => reject(new Error('產生語音逾時，請重試。'));
    xhr.onabort = () => reject(new Error('已停止。'));
    xhr.onloadend = () => { if (pendingRequest === xhr) pendingRequest = null; };
    xhr.send(JSON.stringify(body));
  });
}

function ensureAudio() {
  if (!audioContext) {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw new Error('這個瀏覽器無法播放試說音訊。');
    audioContext = new Audio();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = .72;
    frequency = new Uint8Array(analyser.frequencyBinCount);
    analyser.connect(audioContext.destination);
  }
  return audioContext.resume();
}

function analyseEnvelope(buffer) {
  const step = Math.round(buffer.sampleRate * .02);
  // Use the mixed signal, not just one channel of a future stereo TTS provider.
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const rms = [];
  for (let i = 0; i < buffer.length; i += step) {
    let sum = 0, count = Math.min(step, buffer.length - i);
    for (let j = 0; j < count; j++) {
      const sample = channels.reduce((a, channel) => a + channel[i + j], 0) / channels.length;
      sum += sample * sample;
    }
    rms.push(Math.sqrt(sum / Math.max(1, count)));
  }
  const voiced = rms.filter(v => v > .006).sort((a, b) => a - b);
  envelopeReference = Math.max(.025, voiced[Math.floor(voiced.length * .78)] || .07);
  envelope = rms;
}

function audioAmplitude(time) {
  if (time < 0 || !envelope.length) return 0;
  const position = time / .02, index = Math.floor(position);
  const rms = (envelope[index] || 0) * (1 - (position - index)) + (envelope[index + 1] || 0) * (position - index);
  return Math.pow(clamp((rms - .003) / envelopeReference), .62);
}

function speechTime() {
  if (!audioContext || !playing) return 0;
  // One audio clock drives sound, mouth and subtitles. Compensate output latency.
  const timestamp = audioContext.getOutputTimestamp?.();
  const audibleTime = timestamp && timestamp.contextTime > 0
    ? timestamp.contextTime + Math.max(0, (performance.now() - timestamp.performanceTime) / 1000)
    : audioContext.currentTime - (audioContext.outputLatency || audioContext.baseLatency || 0);
  return Math.max(-.1, audibleTime - playStarted);
}

function addShape(result, shape, weight) {
  if (shape in result) result[shape] += weight;
}

function evaluateVisemes(time, timeline) {
  const result = Object.fromEntries(vowels.map(k => [k, 0]));
  if (!timeline.length || time < timeline[0].start || time > timeline[timeline.length - 1].end) return result;
  // Binary search keeps long phrases cheap; timings come from EdgeTTS, not a timer.
  let lo = 0, hi = timeline.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (timeline[mid].start <= time) lo = mid;
    else hi = mid - 1;
  }
  const event = timeline[lo], previous = timeline[lo - 1], next = timeline[lo + 1];
  if (time > event.end) return result;
  const width = Math.min(.038, (event.end - event.start) * .33);
  if (previous && event.start - previous.end < .035 && time < event.start + width) {
    const k = smooth((time - event.start) / width);
    addShape(result, previous.shape, 1 - k);
    addShape(result, event.shape, k);
  } else if (next && next.start - event.end < .035 && time > event.end - width) {
    const k = smooth((time - (event.end - width)) / width);
    addShape(result, event.shape, 1 - k);
    addShape(result, next.shape, k);
  } else addShape(result, event.shape, 1);
  return result;
}

function subtitleRanges(data) {
  const sentences = [...data.text.matchAll(/[^。！？!?]+[。！？!?]?/g)]
    .map(m => ({ text: m[0].trim(), index: m.index, end: m.index + m[0].length, start: Infinity }));
  let cursor = 0;
  for (const word of data.words) {
    const index = data.text.indexOf(word.text, cursor);
    if (index === -1) continue;
    cursor = index + word.text.length;
    const sentence = sentences.find(s => index >= s.index && index < s.end);
    if (sentence) sentence.start = Math.min(sentence.start, word.offset / 1e7);
  }
  return sentences.filter(s => Number.isFinite(s.start));
}

function selectedMood(time) {
  const selected = $('mood').value;
  if (selected !== 'auto') return selected;
  const sentence = activeSpeech?.subtitles.filter(s => s.start <= time).at(-1)?.text || '';
  if (/哇|太棒|驚|竟然/.test(sentence)) return 'surprised';
  if (/[？?]|想一想|思考/.test(sentence)) return 'thinking';
  if (/你好|高興|謝謝|開心|喜歡/.test(sentence)) return 'happy';
  return 'neutral';
}

async function speak() {
  const text = $('text').value.trim();
  if (!text) { message('先寫一句想說的話吧。', true); $('text').focus(); return; }
  stop(false);
  const thisGeneration = ++generationId;
  busy = true;
  updateButtons();
  $('state').textContent = '準備聲音中';
  message('正在用 EdgeTTS 產生聲音…');
  try {
    await ensureAudio();
    const data = await postJSON('/api/tts', {
      text, voice: $('voice').value, rate: Number($('rate').value), pitch: 0,
    });
    if (thisGeneration !== generationId) return;
    const bytes = Uint8Array.from(atob(data.audio), c => c.charCodeAt(0));
    const buffer = await audioContext.decodeAudioData(bytes.buffer);
    if (thisGeneration !== generationId) return;
    if (!Array.isArray(data.visemes) || !Array.isArray(data.words)) throw new Error('語音時間資料有誤。');
    analyseEnvelope(buffer);
    activeSpeech = { ...data, subtitles: subtitleRanges(data), duration: buffer.duration };
    source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    const currentSource = source;
    source.onended = () => {
      if (source !== currentSource) return;
      currentSource.disconnect();
      source = null; playing = false; activeSpeech = null;
      $('state').textContent = '準備好了';
      $('subtitle').textContent = '我說完了。還想聽我說什麼？';
      message('可以換一句話，或試試不同的表情。');
      updateButtons();
    };
    playStarted = audioContext.currentTime + .045;
    source.start(playStarted);
    playing = true; busy = false;
    $('state').textContent = '正在說話';
    $('subtitle').textContent = activeSpeech.subtitles[0]?.text || text;
    message('試著留意發音、停頓和表情。');
    updateButtons();
  } catch (error) {
    if (thisGeneration !== generationId) return;
    busy = false; playing = false; activeSpeech = null;
    $('state').textContent = '準備好了';
    message(error.message || '試說失敗，請重試。', true);
    updateButtons();
  }
}

function stop(userAction = true) {
  generationId++;
  pendingRequest?.abort();
  if (source) {
    source.onended = null;
    try { source.stop(); } catch { /* already ended */ }
    source.disconnect(); source = null;
  }
  busy = false; playing = false; activeSpeech = null; envelope = []; poseTime = 0;
  // Stopping closes the mouth immediately, even between animation frames.
  for (const key of vowels) { mouth[key] = 0; vrm?.expressionManager.setValue(key, 0); }
  vrm?.expressionManager.update();
  if (modelReady) $('state').textContent = '準備好了';
  if (userAction) {
    $('subtitle').textContent = '已停止。可以重新試說。';
    message('已停止播放。');
  }
  updateButtons();
}

function drawSpectrum() {
  const canvas = $('spectrum'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (analyser && playing) analyser.getByteFrequencyData(frequency);
  ctx.fillStyle = '#218791';
  for (let i = 0; i < 28; i++) {
    const level = playing && frequency ? frequency[Math.round(5 + i * 2.7)] / 255 : 0;
    const height = 3 + level * 26;
    ctx.beginPath();
    ctx.roundRect(i * 11.3 + 2, (32 - height) / 2, 4, height, 2);
    ctx.fill();
  }
}

function animate(now) {
  requestAnimationFrame(animate);
  // Facial damping uses wall time; slow rendering must not leave the mouth open.
  // Only spring-bone physics needs the smaller maximum step below.
  const dt = Math.min(.3, Math.max(.001, (now - (lastFrame || now)) / 1000));
  lastFrame = now; elapsed += dt;
  if (!vrm) return;
  const time = speechTime(), shiftedTime = time + Number($('sync').value) / 1000;
  const amplitude = playing ? audioAmplitude(shiftedTime) : 0;
  const targets = playing && activeSpeech ? evaluateVisemes(shiftedTime, activeSpeech.visemes) : {};
  const voiced = Object.values(targets).some(weight => weight > 0) && amplitude >= .01;
  const gain = Number($('gain').value);
  for (const key of vowels) {
    const target = clamp((targets[key] || 0) * amplitude * .88 * gain, 0, .95);
    mouth[key] = voiced ? approach(mouth[key], target, dt, target > mouth[key] ? 38 : 30) : 0;
    if (!playing && mouth[key] < .001) mouth[key] = 0;
    vrm.expressionManager.setValue(key, mouth[key]);
  }
  const movement = $('expressions').checked;
  const mood = selectedMood(time);
  const moods = {
    neutral: { relaxed: .10, happy: .06 },
    happy: { happy: .24, relaxed: .03 },
    thinking: { sad: .055, surprised: .11, relaxed: .025 },
    surprised: { surprised: .32, happy: .05 },
  };
  for (const key of faceKeys) {
    face[key] = approach(face[key], moods[mood]?.[key] || 0, dt, 3.2);
    vrm.expressionManager.setValue(key, face[key]);
  }
  if (movement && elapsed > nextBlink) {
    blinkAt = elapsed;
    nextBlink = elapsed + 2.8 + Math.random() * 3.2;
  }
  const blinkTime = elapsed - blinkAt;
  const blink = movement && blinkTime < .21
    ? (blinkTime < .085 ? smooth(blinkTime / .085) : 1 - smooth((blinkTime - .085) / .125)) : 0;
  vrm.expressionManager.setValue('blink', blink);
  if (movement && elapsed > nextGaze) {
    gazeGoal = Math.random() < .65 ? { x: 0, y: 0 } : { x: (Math.random() - .5) * .055, y: (Math.random() - .5) * .025 };
    nextGaze = elapsed + 1.8 + Math.random() * 2.8;
  }
  gaze.x = approach(gaze.x, movement ? gazeGoal.x : 0, dt, 3);
  gaze.y = approach(gaze.y, movement ? gazeGoal.y : 0, dt, 3);
  const headPosition = new THREE.Vector3();
  vrm.humanoid.getRawBoneNode('head').getWorldPosition(headPosition);
  gazeTarget.position.set(gaze.x, headPosition.y + .06 + gaze.y, 1.3);
  if (head) {
    const nod = playing ? Math.sin(elapsed * 5) * amplitude * .018 : 0;
    head.rotation.set(restHead.x + (movement ? Math.sin(elapsed * .77) * .018 + nod : 0), restHead.y + (movement ? Math.sin(elapsed * .47) * .026 + gaze.x * .18 : 0), restHead.z + (movement ? Math.sin(elapsed * .58) * .012 : 0));
  }
  if (neck) neck.rotation.set(restNeck.x, restNeck.y, restNeck.z + (movement ? Math.sin(elapsed * .4) * .009 : 0));
  if (chest) chest.rotation.x = movement ? Math.sin(elapsed * 1.1) * .003 : 0;
  vrm.update(Math.min(.06, dt));
  poseTime = time;
  renderer.render(scene, camera);
  if (playing && activeSpeech) {
    const subtitle = activeSpeech.subtitles.filter(s => s.start <= time).at(-1);
    if (subtitle && $('subtitle').textContent !== subtitle.text) $('subtitle').textContent = subtitle.text;
  }
  const top = vowels.reduce((a, b) => mouth[a] > mouth[b] ? a : b);
  $('shape-label').textContent = mouth[top] > .025 ? `${{ aa: 'A', ih: 'I', ou: 'U', ee: 'E', oh: 'O' }[top]} · ${Math.round(mouth[top] * 100)}%` : '閉嘴';
  drawSpectrum();
}

async function initialize() {
  try {
    const canvas = $('scene');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(32, 1, .05, 10);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xa3bed0, 1.8));
    const key = new THREE.DirectionalLight(0xfff7ef, 2.5);
    key.position.set(-1, 2, 3); scene.add(key);
    const loader = new GLTFLoader();
    loader.register(parser => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync('/api/character');
    vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('角色模型格式有誤。');
    // Official VRM optimizations avoid evaluating unused vertices and morphs.
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    VRMUtils.combineMorphs(vrm);
    VRMUtils.rotateVRM0(vrm);
    scene.add(vrm.scene);
    vrm.scene.traverse(object => { object.frustumCulled = false; });
    head = vrm.humanoid.getNormalizedBoneNode('head');
    neck = vrm.humanoid.getNormalizedBoneNode('neck');
    chest = vrm.humanoid.getNormalizedBoneNode('chest');
    restHead = head?.rotation.clone() || new THREE.Euler();
    restNeck = neck?.rotation.clone() || new THREE.Euler();
    const leftArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
    const rightArm = vrm.humanoid.getNormalizedBoneNode('rightUpperArm');
    if (leftArm) leftArm.rotation.z = -1.18;
    if (rightArm) rightArm.rotation.z = 1.18;
    vrm.lookAt.target = gazeTarget;
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    const headPosition = new THREE.Vector3();
    vrm.humanoid.getRawBoneNode('head').getWorldPosition(headPosition);
    const target = headPosition.clone().add(new THREE.Vector3(0, .042, 0));
    camera.position.set(target.x, target.y, target.z + .76);
    camera.lookAt(target);
    function resize() {
      const rect = $('avatar').getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / rect.height;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe($('avatar'));
    resize();
    modelReady = true;
    $('loading').remove();
    $('state').textContent = '準備好了';
    message('按下開始說話，聽聽看。');
    updateButtons();
    requestAnimationFrame(animate);
  } catch (error) {
    $('loading').textContent = '角色載入失敗，請確認是從本機伺服器開啟。';
    message(error.message, true);
    console.error(error);
  }
}

$('speak').addEventListener('click', speak);
$('stop').addEventListener('click', () => stop());
$('text').addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !$('speak').disabled) speak();
});
const samples = {
  hello: '你好，羽山。我是米歐，很高興見到你。今天想聊些什麼呢？',
  question: '嗯，讓我想一想。你最近做過最有成就感的專案，是哪一個呢？可以跟我分享嗎？',
  vowels: '啊，衣，烏，鵝，喔。白貓慢慢跑，微風吹過湖面。哇，太棒了！謝謝你。',
};
document.querySelectorAll('[data-sample]').forEach(button => button.addEventListener('click', () => {
  $('text').value = samples[button.dataset.sample];
}));
for (const id of ['rate', 'gain', 'sync']) $(id).addEventListener('input', () => {
  const v = Number($(id).value);
  $(`${id}-value`).textContent = id === 'rate' ? v ? `${v > 0 ? '+' : ''}${v}%` : '正常' : id === 'gain' ? v.toFixed(1) : `${v} ms`;
});
window.addEventListener('pagehide', () => stop(false));
// Tiny observable surface for regression checks and future integration.
window.avatarHead = {
  speak, stop,
  getState: () => ({ modelReady, playing, busy, time: speechTime(), poseTime, mouth: { ...mouth }, face: { ...face }, blink: vrm?.expressionManager.getValue('blink') || 0, visemeCount: activeSpeech?.visemes.length || 0 }),
};
initialize();
