const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/';
const SAMPLE_TARGET = 5;
const SAMPLE_GAP_MS = 700;
const SAMPLE_TIMEOUT_MS = 20000;
const SCAN_TIMEOUT_MS = 10000;
const CAMERA_TABS = ['absen', 'siswa'];

const pick = (selector) => document.querySelector(selector);

const dom = {
  clockTime: pick('.clock-time'),
  clockDate: pick('.clock-date'),
  account: pick('.account'),
  accountName: pick('.account-name'),
  btnLogout: pick('.btn-logout'),
  screens: document.querySelectorAll('[data-screen]'),
  layout: pick('.layout'),
  loginForm: pick('.login-form'),
  loginUser: pick('.login-user'),
  loginError: pick('.login-error'),
  btnLogin: pick('.btn-login'),
  passwordForms: document.querySelectorAll('.password-form'),
  stage: pick('.stage'),
  video: pick('.video'),
  overlay: pick('.overlay'),
  verdict: pick('.verdict'),
  verdictTitle: pick('.verdict-title'),
  verdictText: pick('.verdict-text'),
  btnCamera: pick('.btn-camera'),
  tabs: document.querySelectorAll('.tab'),
  views: document.querySelectorAll('.view'),
  roleBlocks: document.querySelectorAll('[data-only]'),
  todayCard: pick('.today-card'),
  todayStatus: pick('.today-status'),
  todayDetail: pick('.today-detail'),
  btnScan: pick('.btn-scan'),
  historyList: pick('.history-list'),
  historyEmpty: pick('.history-empty'),
  studentForm: pick('.student-form'),
  inputNama: pick('.input-nama'),
  inputNis: pick('.input-nis'),
  inputKelas: pick('.input-kelas'),
  btnRegister: pick('.btn-register'),
  registerHint: pick('.student-form .form-hint'),
  credBox: pick('.cred-box'),
  credTitle: pick('.cred-title'),
  credUser: pick('.cred-user'),
  credPass: pick('.cred-pass'),
  btnCredClose: pick('.btn-cred-close'),
  studentList: pick('.student-list'),
  studentEmpty: pick('.student-empty'),
  rekapDate: pick('.rekap-date'),
  rekapKelas: pick('.rekap-kelas'),
  btnExport: pick('.btn-export'),
  rekapSummary: pick('.rekap-summary'),
  rekapBody: pick('.rekap-body'),
  rekapEmpty: pick('.rekap-empty'),
  inputBatas: pick('.input-batas'),
  btnBatas: pick('.btn-batas'),
  batasHint: pick('.batas-hint')
};

const state = {
  user: null,
  students: [],
  rekapRows: [],
  rekapTanggal: '',
  modelsReady: false,
  modelsLoading: false,
  cameraOn: false,
  stream: null,
  timer: null,
  busy: false,
  tab: '',
  sampling: null,
  registering: false,
  scanning: false
};

const registerHintDefault = 'Nyalakan kamera, siswa hadap lurus, lalu tengok sedikit ke kiri dan kanan saat merekam.';
const batasHintDefault = 'Siswa yang absen setelah jam ini tercatat terlambat.';

async function api(path, options = {}) {
  const config = { method: options.method || 'GET', credentials: 'same-origin', headers: {} };
  if (options.body !== undefined) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(path, config);
  } catch (error) {
    const offline = new Error('Tidak bisa terhubung ke server. Periksa koneksi internet.');
    offline.status = 0;
    throw offline;
  }
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    if (response.status === 401 && !options.quiet) {
      resetToLogin('Sesi berakhir. Silakan masuk lagi.');
    }
    const failure = new Error(data && data.pesan ? data.pesan : 'Terjadi kesalahan.');
    failure.status = response.status;
    throw failure;
  }
  return data;
}

function pad(number) {
  return String(number).padStart(2, '0');
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showScreen(name) {
  dom.screens.forEach((screen) => {
    screen.hidden = screen.dataset.screen !== name;
  });
}

function setVerdict(tone, title, text) {
  dom.verdict.dataset.tone = tone;
  dom.verdictTitle.textContent = title;
  dom.verdictText.textContent = text;
}

function setHint(node, text, isError = false) {
  node.textContent = text;
  node.classList.toggle('is-error', isError);
}

function reportError(error) {
  if (error && error.status === 401) return;
  setVerdict('error', 'Terjadi kesalahan', error && error.message ? error.message : 'Coba lagi beberapa saat.');
}

function formatTanggal(tanggal) {
  const date = new Date(`${tanggal}T00:00:00`);
  return date.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function tickClock() {
  const now = new Date();
  dom.clockTime.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  dom.clockDate.textContent = now.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
}

function idleVerdict() {
  if (!state.user || !state.modelsReady) return;
  if (!state.cameraOn) {
    setVerdict('idle', 'Kamera belum menyala', 'Tekan Nyalakan kamera untuk memulai.');
    return;
  }
  if (state.tab === 'absen') {
    setVerdict('info', 'Siap memindai', 'Hadap lurus ke kamera lalu tekan Absen sekarang.');
  } else if (state.tab === 'siswa') {
    setVerdict('info', 'Mode pendaftaran', 'Isi data siswa lalu tekan Rekam wajah dan buat akun.');
  }
}

async function ensureModels() {
  if (state.modelsReady || state.modelsLoading) return;
  state.modelsLoading = true;
  dom.btnCamera.disabled = true;
  setVerdict('loading', 'Memuat model pengenalan wajah', 'Tunggu beberapa detik, model diunduh sekali saja.');
  try {
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
    state.modelsReady = true;
    dom.btnCamera.disabled = false;
    idleVerdict();
  } catch (error) {
    setVerdict('error', 'Model gagal dimuat', 'Periksa koneksi internet lalu muat ulang halaman.');
  } finally {
    state.modelsLoading = false;
  }
}

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setVerdict('error', 'Kamera tidak tersedia', 'Buka aplikasi lewat alamat https agar kamera bisa dipakai.');
    return;
  }
  dom.btnCamera.disabled = true;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    dom.video.srcObject = state.stream;
    await dom.video.play();
    dom.overlay.width = dom.video.videoWidth || 640;
    dom.overlay.height = dom.video.videoHeight || 480;
    state.cameraOn = true;
    dom.stage.classList.add('is-live');
    dom.btnCamera.textContent = 'Matikan kamera';
    dom.btnCamera.classList.add('is-on');
    idleVerdict();
    tick();
  } catch (error) {
    const denied = error && error.name === 'NotAllowedError';
    setVerdict(
      'error',
      'Kamera tidak bisa dibuka',
      denied ? 'Izin kamera ditolak. Izinkan akses kamera di pengaturan peramban.' : 'Pastikan kamera terpasang dan tidak dipakai aplikasi lain.'
    );
  } finally {
    dom.btnCamera.disabled = !state.modelsReady;
  }
}

function stopCamera() {
  state.cameraOn = false;
  clearTimeout(state.timer);
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  dom.video.srcObject = null;
  clearOverlay();
  dom.stage.classList.remove('is-live');
  dom.btnCamera.textContent = 'Nyalakan kamera';
  dom.btnCamera.classList.remove('is-on');
  idleVerdict();
}

function clearOverlay() {
  const ctx = dom.overlay.getContext('2d');
  ctx.clearRect(0, 0, dom.overlay.width, dom.overlay.height);
}

function drawBox(detection) {
  clearOverlay();
  if (!detection) return;
  const ctx = dom.overlay.getContext('2d');
  const box = detection.detection.box;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'hsl(45 96% 58%)';
  ctx.strokeRect(box.x, box.y, box.width, box.height);
}

async function detectFace() {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  return faceapi.detectSingleFace(dom.video, options).withFaceLandmarks().withFaceDescriptor();
}

async function tick() {
  if (!state.cameraOn) return;
  if (!state.busy) {
    state.busy = true;
    try {
      const detection = await detectFace();
      if (state.cameraOn) {
        drawBox(detection);
        if (state.sampling && detection) state.sampling.push(detection.descriptor);
      }
    } catch (error) {
      console.error(error);
    } finally {
      state.busy = false;
    }
  }
  state.timer = setTimeout(tick, 450);
}

function collectSamples(target, timeout, onProgress) {
  return new Promise((resolve, reject) => {
    const samples = [];
    let lastAt = 0;
    const timer = setTimeout(() => {
      state.sampling = null;
      reject(new Error('timeout'));
    }, timeout);
    state.sampling = {
      push(descriptor) {
        const now = Date.now();
        if (now - lastAt < SAMPLE_GAP_MS) return;
        lastAt = now;
        samples.push(Array.from(descriptor));
        if (onProgress) onProgress(samples.length, target);
        if (samples.length >= target) {
          clearTimeout(timer);
          state.sampling = null;
          resolve(samples);
        }
      }
    };
  });
}

function renderToday(record) {
  if (!record) {
    dom.todayCard.dataset.tone = 'idle';
    dom.todayStatus.textContent = 'Belum absen';
    dom.todayDetail.textContent = 'Nyalakan kamera, hadap lurus, lalu tekan tombol di bawah.';
    return;
  }
  dom.todayCard.dataset.tone = record.status === 'Hadir' ? 'ok' : 'late';
  dom.todayStatus.textContent = record.status;
  dom.todayDetail.textContent = `Tercatat pukul ${record.jam}.`;
}

function renderHistory(riwayat) {
  dom.historyList.replaceChildren();
  riwayat.forEach((item) => {
    const row = make('li', 'row');
    const main = make('div', 'row-main');
    main.append(make('span', 'row-name', formatTanggal(item.tanggal)), make('span', 'row-meta', `Pukul ${item.jam}`));
    row.append(main, make('span', item.status === 'Hadir' ? 'badge badge-ok' : 'badge badge-late', item.status));
    dom.historyList.append(row);
  });
  dom.historyEmpty.hidden = riwayat.length > 0;
}

async function loadRiwayat() {
  try {
    const data = await api('/api/riwayat');
    renderHistory(data.riwayat);
    renderToday(data.riwayat.find((item) => item.tanggal === data.tanggal) || null);
  } catch (error) {
    reportError(error);
  }
}

async function handleScan() {
  if (state.scanning) return;
  if (!state.modelsReady) {
    setVerdict('warn', 'Model belum siap', 'Tunggu hingga model pengenalan wajah selesai dimuat.');
    return;
  }
  if (!state.cameraOn) {
    setVerdict('warn', 'Kamera belum menyala', 'Nyalakan kamera sebelum absen.');
    return;
  }
  state.scanning = true;
  dom.btnScan.disabled = true;
  setVerdict('info', 'Memindai wajah', 'Tetap hadap lurus ke kamera.');
  try {
    const samples = await collectSamples(1, SCAN_TIMEOUT_MS);
    const result = await api('/api/absen', { method: 'POST', body: { descriptor: samples[0] } });
    if (result.sudahAbsen) {
      setVerdict('info', 'Kamu sudah absen hari ini', `Tercatat pukul ${result.jam} dengan status ${result.status}.`);
    } else if (result.status === 'Hadir') {
      setVerdict('ok', 'Absen berhasil', `Kamu tercatat hadir pukul ${result.jam}.`);
    } else {
      setVerdict('late', 'Absen berhasil, tapi terlambat', `Kamu tercatat terlambat pukul ${result.jam}.`);
    }
    await loadRiwayat();
  } catch (error) {
    if (error.message === 'timeout') {
      setVerdict('error', 'Wajah tidak terdeteksi', 'Perbaiki cahaya, hadap lurus ke kamera, lalu coba lagi.');
    } else if (error.status === 422) {
      setVerdict('error', 'Wajah tidak cocok', error.message);
    } else {
      reportError(error);
    }
  } finally {
    state.sampling = null;
    state.scanning = false;
    dom.btnScan.disabled = false;
  }
}

function showCredentials(title, username, password) {
  dom.credTitle.textContent = title;
  dom.credUser.textContent = username;
  dom.credPass.textContent = password;
  dom.credBox.hidden = false;
}

async function handleRegister(event) {
  event.preventDefault();
  if (state.registering) return;
  if (!state.cameraOn) {
    setHint(dom.registerHint, 'Nyalakan kamera terlebih dahulu.', true);
    setVerdict('warn', 'Kamera belum menyala', 'Nyalakan kamera sebelum merekam wajah.');
    return;
  }
  const nama = dom.inputNama.value.trim();
  const nis = dom.inputNis.value.trim();
  const kelas = dom.inputKelas.value.trim();
  if (!nama || !nis || !kelas) {
    setHint(dom.registerHint, 'Lengkapi nama, NIS, dan kelas.', true);
    return;
  }
  state.registering = true;
  dom.btnRegister.disabled = true;
  setHint(dom.registerHint, 'Hadap lurus ke kamera...');
  try {
    const samples = await collectSamples(SAMPLE_TARGET, SAMPLE_TIMEOUT_MS, (done, total) => {
      setHint(dom.registerHint, `Merekam wajah ${done} dari ${total}`);
      setVerdict('info', 'Merekam wajah', `Sampel ${done} dari ${total}. Tengok sedikit ke kiri dan kanan.`);
    });
    const created = await api('/api/admin/siswa', { method: 'POST', body: { nama, nis, kelas, descriptors: samples } });
    dom.studentForm.reset();
    setHint(dom.registerHint, registerHintDefault);
    setVerdict('ok', `${created.nama} berhasil didaftarkan`, 'Berikan username dan kata sandi awal ke siswa.');
    showCredentials(`Akun ${created.nama} dibuat`, created.username, created.passwordAwal);
    await loadStudents();
  } catch (error) {
    if (error.message === 'timeout') {
      setHint(dom.registerHint, 'Wajah tidak terdeteksi. Perbaiki cahaya lalu coba lagi.', true);
      setVerdict('error', 'Wajah tidak terdeteksi', 'Hadap lurus ke kamera dan pastikan wajah tidak tertutup.');
    } else if (error.status !== 401) {
      setHint(dom.registerHint, error.message, true);
      setVerdict('error', 'Pendaftaran gagal', error.message);
    }
  } finally {
    state.sampling = null;
    state.registering = false;
    dom.btnRegister.disabled = false;
  }
}

async function loadStudents() {
  try {
    const data = await api('/api/admin/siswa');
    state.students = data.siswa;
    renderStudents();
    renderKelasOptions();
  } catch (error) {
    reportError(error);
  }
}

function renderStudents() {
  dom.studentList.replaceChildren();
  state.students.forEach((siswa) => {
    const row = make('li', 'row');
    const main = make('div', 'row-main');
    main.append(make('span', 'row-name', siswa.nama), make('span', 'row-meta', `NIS ${siswa.nis}, kelas ${siswa.kelas}`));
    const actions = make('div', 'row-actions');
    const reset = make('button', 'btn btn-small btn-ghost', 'Reset sandi');
    reset.type = 'button';
    reset.addEventListener('click', () => resetPassword(siswa));
    const remove = make('button', 'btn btn-small btn-danger', 'Hapus');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteStudent(siswa));
    actions.append(reset, remove);
    row.append(main, actions);
    dom.studentList.append(row);
  });
  dom.studentEmpty.hidden = state.students.length > 0;
}

async function resetPassword(siswa) {
  if (!window.confirm(`Buat kata sandi baru untuk ${siswa.nama}?`)) return;
  try {
    const result = await api(`/api/admin/siswa/${siswa.id}/reset-password`, { method: 'POST' });
    showCredentials(`Kata sandi baru untuk ${result.nama}`, result.username, result.passwordBaru);
    dom.credBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    reportError(error);
  }
}

async function deleteStudent(siswa) {
  if (!window.confirm(`Hapus ${siswa.nama}? Akun dan seluruh riwayat kehadirannya ikut terhapus.`)) return;
  try {
    await api(`/api/admin/siswa/${siswa.id}`, { method: 'DELETE' });
    await loadStudents();
  } catch (error) {
    reportError(error);
  }
}

function renderKelasOptions() {
  const current = dom.rekapKelas.value || 'semua';
  const kelasList = [...new Set(state.students.map((s) => s.kelas))].sort((a, b) => a.localeCompare(b, 'id'));
  dom.rekapKelas.replaceChildren();
  const all = make('option', '', 'Semua kelas');
  all.value = 'semua';
  dom.rekapKelas.append(all);
  kelasList.forEach((kelas) => {
    const option = make('option', '', kelas);
    option.value = kelas;
    dom.rekapKelas.append(option);
  });
  dom.rekapKelas.value = kelasList.includes(current) ? current : 'semua';
}

async function loadRekap() {
  const query = new URLSearchParams({ tanggal: dom.rekapDate.value || state.user.tanggal });
  const kelas = dom.rekapKelas.value || 'semua';
  if (kelas !== 'semua') query.set('kelas', kelas);
  try {
    const data = await api(`/api/admin/rekap?${query.toString()}`);
    state.rekapRows = data.rows;
    state.rekapTanggal = data.tanggal;
    renderRekap();
  } catch (error) {
    reportError(error);
  }
}

function renderRekap() {
  const rows = state.rekapRows;
  dom.rekapBody.replaceChildren();
  rows.forEach((item) => {
    const tr = make('tr');
    const badgeClass = item.status === 'Hadir' ? 'badge badge-ok' : item.status === 'Terlambat' ? 'badge badge-late' : 'badge badge-none';
    const statusCell = make('td');
    statusCell.append(make('span', badgeClass, item.status));
    tr.append(make('td', '', item.nama), make('td', '', item.kelas), make('td', '', item.jam || '-'), statusCell);
    dom.rekapBody.append(tr);
  });
  const hadir = rows.filter((r) => r.status === 'Hadir').length;
  const telat = rows.filter((r) => r.status === 'Terlambat').length;
  const belum = rows.length - hadir - telat;
  dom.rekapSummary.textContent = rows.length
    ? `${rows.length} siswa: ${hadir} hadir, ${telat} terlambat, ${belum} belum hadir.`
    : '';
  dom.rekapEmpty.hidden = rows.length > 0;
  dom.btnExport.disabled = rows.length === 0;
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function exportCsv() {
  if (!state.rekapRows.length) return;
  const header = ['Tanggal', 'NIS', 'Nama', 'Kelas', 'Jam', 'Status'];
  const lines = [header, ...state.rekapRows.map((r) => [state.rekapTanggal, r.nis, r.nama, r.kelas, r.jam, r.status])]
    .map((line) => line.map(csvCell).join(','));
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `kehadiranku-${state.rekapTanggal}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function saveBatas() {
  if (!dom.inputBatas.value) {
    setHint(dom.batasHint, 'Isi jam terlebih dahulu.', true);
    return;
  }
  try {
    const result = await api('/api/admin/pengaturan', { method: 'PUT', body: { batas: dom.inputBatas.value } });
    state.user.batas = result.batas;
    setHint(dom.batasHint, `Batas jam masuk disimpan: ${result.batas}.`);
  } catch (error) {
    if (error.status !== 401) setHint(dom.batasHint, error.message, true);
  }
}

async function submitPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const hint = form.querySelector('.form-hint');
  const lama = form.elements.lama.value;
  const baru = form.elements.baru.value;
  const ulang = form.elements.ulang.value;
  if (baru.length < 8) {
    setHint(hint, 'Kata sandi baru minimal 8 karakter.', true);
    return;
  }
  if (baru !== ulang) {
    setHint(hint, 'Pengulangan kata sandi tidak sama.', true);
    return;
  }
  try {
    await api('/api/ganti-password', { method: 'POST', body: { lama, baru } });
    form.reset();
    if (state.user && state.user.wajibGanti) {
      handleUser(await api('/api/me'));
      return;
    }
    setHint(hint, 'Kata sandi berhasil diganti.');
  } catch (error) {
    if (error.status !== 401) setHint(hint, error.message, true);
  }
}

function switchTab(name) {
  state.tab = name;
  dom.tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  dom.views.forEach((view) => {
    view.hidden = view.dataset.view !== name;
  });
  const needsCamera = CAMERA_TABS.includes(name);
  dom.layout.classList.toggle('no-stage', !needsCamera);
  if (!needsCamera && state.cameraOn) stopCamera();
  if (name === 'absen') loadRiwayat();
  if (name === 'siswa') loadStudents();
  if (name === 'rekap') {
    if (!state.students.length) {
      loadStudents().then(loadRekap);
    } else {
      loadRekap();
    }
  }
  idleVerdict();
}

function enterApp() {
  const user = state.user;
  dom.accountName.textContent = user.role === 'admin' ? `Admin ${user.username}` : user.siswa ? user.siswa.nama : user.username;
  dom.account.hidden = false;
  dom.tabs.forEach((tab) => {
    const role = tab.dataset.role;
    tab.hidden = !(role === 'semua' || role === user.role);
  });
  dom.roleBlocks.forEach((block) => {
    block.hidden = block.dataset.only !== user.role;
  });
  dom.inputBatas.value = user.batas;
  dom.rekapDate.value = user.tanggal;
  setHint(dom.batasHint, batasHintDefault);
  dom.credBox.hidden = true;
  showScreen('app');
  switchTab(user.role === 'admin' ? 'siswa' : 'absen');
  ensureModels();
}

function handleUser(user) {
  state.user = user;
  if (user.wajibGanti) {
    dom.accountName.textContent = user.siswa ? user.siswa.nama : user.username;
    dom.account.hidden = false;
    showScreen('ganti');
    return;
  }
  enterApp();
}

function resetToLogin(message) {
  if (state.cameraOn) stopCamera();
  state.user = null;
  state.students = [];
  state.rekapRows = [];
  dom.account.hidden = true;
  dom.loginForm.reset();
  setHint(dom.loginError, message || '', true);
  showScreen('login');
}

async function handleLogin(event) {
  event.preventDefault();
  dom.btnLogin.disabled = true;
  setHint(dom.loginError, '', true);
  try {
    const user = await api('/api/login', {
      method: 'POST',
      quiet: true,
      body: { username: dom.loginUser.value.trim(), password: dom.loginForm.elements.password.value }
    });
    dom.loginForm.reset();
    handleUser(user);
  } catch (error) {
    setHint(dom.loginError, error.message, true);
  } finally {
    dom.btnLogin.disabled = false;
  }
}

async function handleLogout() {
  try {
    await api('/api/logout', { method: 'POST', quiet: true });
  } catch (error) {
    console.error(error);
  }
  resetToLogin('');
}

function bindEvents() {
  dom.loginForm.addEventListener('submit', handleLogin);
  dom.btnLogout.addEventListener('click', handleLogout);
  dom.passwordForms.forEach((form) => form.addEventListener('submit', submitPassword));
  dom.btnCamera.addEventListener('click', () => {
    if (state.cameraOn) stopCamera();
    else startCamera();
  });
  dom.tabs.forEach((tab) => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  dom.btnScan.addEventListener('click', handleScan);
  dom.studentForm.addEventListener('submit', handleRegister);
  dom.btnCredClose.addEventListener('click', () => {
    dom.credBox.hidden = true;
    dom.credPass.textContent = '';
  });
  dom.rekapDate.addEventListener('change', loadRekap);
  dom.rekapKelas.addEventListener('change', loadRekap);
  dom.btnExport.addEventListener('click', exportCsv);
  dom.btnBatas.addEventListener('click', saveBatas);
}

async function init() {
  bindEvents();
  tickClock();
  setInterval(tickClock, 1000);
  try {
    const user = await api('/api/me', { quiet: true });
    handleUser(user);
  } catch (error) {
    showScreen('login');
  }
}

init();
