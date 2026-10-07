const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
const API_BASE = 'http://localhost/smartfan/api/';
const saved = JSON.parse(localStorage.getItem('smartfan_state') || 'null');
const state = saved || {
  loggedIn: false,
  firstLoginComplete: false,
  user: {
    name: 'Nadia Pratama',
    email: 'nadia@example.com',
    password: ''
  },
  route: '',
  demo: true,
  sensors: {
    temperature: 24,
    humidity: 60,
    power: 120
  },
  selectedDevice: 'living-room',
  devices: [{
    id: 'living-room',
    name: 'Ruang Tamu',
    temperature: 24.5,
    humidity: 60,
    temperatureTarget: 26,
    power: false,
    speed: 0,
    mode: 'manual',
    oscillation: 45,
    eco: false,
    activationMode: 'manual',
    autoControlled: false
  }, {
    id: 'bedroom',
    name: 'Kamar Tidur',
    temperature: 25.2,
    humidity: 58,
    temperatureTarget: 26,
    power: false,
    speed: 0,
    mode: 'sleep',
    oscillation: 0,
    eco: true,
    activationMode: 'manual',
    autoControlled: false
  }, {
    id: 'study-room',
    name: 'Ruang Belajar',
    temperature: 26.1,
    humidity: 62,
    temperatureTarget: 26,
    power: false,
    speed: 0,
    mode: 'manual',
    oscillation: 0,
    eco: false,
    activationMode: 'manual'
  }, {
    id: 'terrace',
    name: 'Teras',
    temperature: 28.4,
    humidity: 67,
    temperatureTarget: 26,
    power: false,
    speed: 0,
    mode: 'manual',
    oscillation: 0,
    eco: false,
    activationMode: 'manual'
  }],
  schedules: [],
  statistics: null,
  mode: 'auto_cool',
  range: 'week',
  tariff: 1444,
  theme: 'dark',
  connection: {
    baseUrl: 'http://smartfan.local',
    connected: false,
    lastSeen: null
  }
};
let splashTimer;
const persist = () => localStorage.setItem('smartfan_state', JSON.stringify(state));
state.connection = {
  baseUrl: 'http://smartfan.local',
  connected: false,
  lastSeen: null,
  ...(state.connection || {})
};
state.theme = state.theme === 'light' ? 'light' : 'dark';
const applyTheme = () => document.documentElement.dataset.theme = state.theme;
applyTheme();
const defaultRoomSensors = {
  'living-room': { temperature: 24.5, humidity: 60 },
  bedroom: { temperature: 25.2, humidity: 58 },
  'study-room': { temperature: 26.1, humidity: 62 },
  terrace: { temperature: 28.4, humidity: 67 }
};
state.devices.forEach(fan => {
  const defaults = defaultRoomSensors[fan.id] || defaultRoomSensors['living-room'];
  fan.temperature = Number.isFinite(fan.temperature) ? fan.temperature : defaults.temperature;
  fan.humidity = Number.isFinite(fan.humidity) ? fan.humidity : defaults.humidity;
  fan.temperatureTarget = Number.isFinite(fan.temperatureTarget) ? fan.temperatureTarget : 26;
  fan.activationMode = fan.activationMode === 'temperature' ? 'temperature' : 'manual';
  fan.autoControlled = Boolean(fan.autoControlled);
});
state.schedules.forEach(scheduleItem => {
  if (!scheduleItem.offTime) {
    const [hours, minutes] = scheduleItem.time.split(':').map(Number);
    const fallback = new Date(2000, 0, 1, hours, minutes + 60);
    scheduleItem.offTime = `${String(fallback.getHours()).padStart(2, '0')}:${String(fallback.getMinutes()).padStart(2, '0')}`;
  }
});
const roomSensorAverage = key => state.devices.reduce((sum, fan) => sum + fan[key], 0) / Math.max(1, state.devices.length);
const esp32Url = path => `${state.connection.baseUrl.replace(/\/$/, '')}${path}`;
const setConnectionState = (connected, message = '') => {
  state.connection.connected = connected;
  if (connected) state.connection.lastSeen = new Date().toISOString();
  persist();
  if (message) toast(message);
};
const esp32Request = async (path, options = {}) => {
  if (state.demo) return null;
  if (path === '/api/status') {
    const devices = await apiRequest('devices.php');
    const rooms = await Promise.all(devices.map(async deviceData => {
      const device = normalizeDevice(deviceData);
      const sensor = await apiRequest(`sensor_data.php?device_id=${device.backendId}&latest=1`);
      return { ...device, ...(sensor || {}) };
    }));
    return { rooms };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(esp32Url(path), {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setConnectionState(true);
    return response.status === 204 ? null : response.json();
  } catch (error) {
    setConnectionState(false);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};
const syncWithEsp32 = (path, payload, successMessage = '') => {
  if (state.demo) return;
  let request;
  const fanMatch = path.match(/^\/api\/fans\/([^/]+)\/(power|control|automation)$/);
  if (fanMatch) {
    const fan = state.devices.find(item => item.id === decodeURIComponent(fanMatch[1]));
    const body = { ...payload };
    if (fan) {
      if (fanMatch[2] === 'power') {
        body.power = body.on;
        body.speed = body.on ? Math.max(60, fan.speed) : 0;
        body.mode = body.on ? (fan.mode || 'manual') : 'manual';
      }
      if (fanMatch[2] === 'automation') {
        body.activation_mode = body.mode;
        body.temperature_target = body.temperatureTarget;
        delete body.mode;
        delete body.temperatureTarget;
      }
      delete body.on;
      request = apiRequest(`devices.php?id=${fan.backendId}`, { method: 'PUT', body: JSON.stringify(body) });
    }
  } else if (path === '/api/mode') {
    request = apiRequest('settings.php', { method: 'PUT', body: JSON.stringify({ mode: payload.mode }) });
  }
  if (!request) return;
  request.then(() => {
    if (successMessage) toast(successMessage);
  }).catch(error => toast(error.message));
};
const syncTemperatureAutomation = fan => {
  syncWithEsp32(`/api/fans/${encodeURIComponent(fan.id)}/automation`, {
    mode: fan.activationMode,
    temperatureTarget: fan.temperatureTarget
  });
};
const syncSchedulesWithEsp32 = () => {
  if (state.demo) return;
  Promise.all(state.schedules.map(scheduleItem => apiRequest(`schedules.php?id=${scheduleItem.backendId}`, {
    method: 'PUT',
    body: JSON.stringify({
      label: scheduleItem.label,
      on_time: scheduleItem.time,
      off_time: scheduleItem.offTime,
      mode: scheduleItem.mode,
      days: scheduleItem.days,
      active: scheduleItem.active
    })
  }))).catch(error => toast(error.message));
};
const route = () => (location.hash.replace('#/', '') || 'onboarding').split('/');
const go = path => {
  location.hash = `/${path}`;
};
const toast = message => {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
};
const apiRequest = async (path, options = {}) => {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch (error) {
    const preview = responseText.trim().replace(/\s+/g, ' ').slice(0, 160);
    throw new Error(`API ${path} tidak mengirim JSON (HTTP ${response.status}): ${preview || 'respons kosong'}`);
  }
  if (!response.ok || !result.success) throw new Error(result.message || 'Permintaan API gagal');
  return result.data;
};
const normalizeDevice = deviceData => ({
  ...deviceData,
  id: deviceData.device_code || String(deviceData.id),
  backendId: Number(deviceData.id),
  temperature: Number(deviceData.temperature) || 0,
  humidity: Number(deviceData.humidity) || 0,
  temperatureTarget: Number(deviceData.temperature_target) || 26,
  power: Boolean(Number(deviceData.power)),
  speed: Number(deviceData.power) ? Number(deviceData.speed) || 0 : 0,
  oscillation: Number(deviceData.oscillation) || 0,
  eco: Boolean(Number(deviceData.eco)),
  activationMode: deviceData.activation_mode || 'manual',
  autoControlled: Boolean(Number(deviceData.auto_controlled))
});
const normalizeSchedule = scheduleData => ({
  ...scheduleData,
  id: String(scheduleData.id),
  backendId: Number(scheduleData.id),
  time: scheduleData.on_time,
  offTime: scheduleData.off_time,
  days: Array.isArray(scheduleData.days) ? scheduleData.days : String(scheduleData.days || '').split(',').filter(Boolean)
});
const loadStatistics = async range => {
  state.statistics = await apiRequest(`statistics.php?range=${encodeURIComponent(range)}`);
  persist();
};
const loadBackendData = async () => {
  const [devices, schedules, profile, settingsData, statistics] = await Promise.all([
    apiRequest('devices.php'),
    apiRequest('schedules.php'),
    apiRequest('profile.php'),
    apiRequest('settings.php'),
    apiRequest(`statistics.php?range=${encodeURIComponent(state.range)}`)
  ]);
  state.devices = devices.map(normalizeDevice);
  devices.filter(deviceData => !Number(deviceData.power) && Number(deviceData.speed) !== 0).forEach(deviceData => {
    apiRequest(`devices.php?id=${deviceData.id}`, {
      method: 'PUT',
      body: JSON.stringify({ power: false, speed: 0 })
    }).catch(error => console.error('Gagal menyelaraskan kecepatan perangkat:', error));
  });
  state.schedules = schedules.map(normalizeSchedule);
  state.user = {
    ...state.user,
    ...profile,
    birthDate: profile.birth_date,
    createdAt: profile.created_at
  };
  state.mode = settingsData.mode || state.mode;
  state.range = settingsData.statistic_range || state.range;
  state.tariff = Number(settingsData.electricity_tariff) || state.tariff;
  state.theme = settingsData.theme === 'light' ? 'light' : 'dark';
  state.connection.baseUrl = settingsData.esp32_url || state.connection.baseUrl;
  state.statistics = statistics;
  applyTheme();
  state.demo = false;
  persist();
};
const device = () => state.devices.find(d => d.id === state.selectedDevice) || state.devices[0];
const prepareFirstLogin = () => {
  if (state.firstLoginComplete) return;
  state.devices.forEach(fan => {
    fan.power = false;
    fan.speed = 0;
  });
  state.schedules.forEach(scheduleItem => {
    scheduleItem.active = false;
  });
  state.firstLoginComplete = true;
};
document.addEventListener('click', e => {
  const signup = e.target.closest('.login-footer a[href="#/register"]');
  if (signup) {
    e.preventDefault();
    go('register');
    return;
  }
});
const greeting = () => {
  const h = new Date().getHours();
  return h < 11 ? 'Pagi' : h < 15 ? 'Siang' : h < 18 ? 'Sore' : 'Malam';
};
const greetingName = () => (state.user && state.user.name ? state.user.name.split(' ')[0] : 'Pengguna');
const formatDate = value => {
  if (!value) return 'Belum diisi';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  });
};
const rupiah = n => new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0
}).format(n).replace('IDR', 'Rp');
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;'
} [char]));
const navItems = [
  ['dashboard', 'home', 'Beranda'],
  ['fan-modes', 'fan', 'Kipas'],
  ['stats', 'chart', 'Statistik'],
  ['account', 'user', 'Akun']
];

function shell(content, active = 'dashboard', title = 'Smart Fan') {
  const connectionLabel = state.demo ? 'Mode Simulasi' : state.connection.connected ? 'ESP32 Terhubung' : 'ESP32 Offline';
  const connectionDetail = state.demo ? 'Data lokal di browser' : state.connection.baseUrl;
  return `<div class="app-shell"><aside class="sidebar"><a class="brand" href="#/dashboard">${icon('fan')}<span>SMART FAN</span></a><div class="nav-label mono">CONTROL CENTER</div><nav class="nav-list">${navItems.map(([r,i,l])=>`<a class="nav-link ${active===r?'active':''}" href="#/${r}">${icon(i)}<span>${l}</span></a>`).join('')}</nav><div class="sidebar-bottom"><div class="nav-label mono">SYSTEM</div><a class="nav-link ${active==='settings'?'active':''}" href="#/settings">${icon('settings')}<span>Pengaturan</span></a><div class="sidebar-status"><b><i class="status-dot"></i> ${connectionLabel}</b><span>${escapeHtml(connectionDetail)}</span></div></div></aside><main class="main"><header class="topbar"><button class="icon-btn mobile-menu" data-action="menu" aria-label="Buka menu">${icon('menu')}</button><div class="eyebrow">${title}</div></header>${content}</main></div>`;
}

function onboarding() {
  return `<div class="onboarding"><section class="onboard-shell"><div class="onboard-visual"><div class="visual-mark">${icon('fan')} SMART AIR FLOW</div><div class="visual-bottom"><div class="eyebrow">SMART HOME / 01</div><h2>Control the air around you.</h2><p>Quiet intelligence for rooms that feel exactly right.</p></div></div><div class="onboard-content"><div class="eyebrow">${icon('fan')} SMART AIR FLOW</div><h1>Kenyamanan Suhu di Setiap Momen</h1><p>Kendalikan iklim ruangan Anda dengan presisi. Teknologi sirkulasi cerdas beradaptasi dengan rutinitas harian untuk memberikan kesejukan yang sempurna, kapan saja.</p><div class="feature-row"><div class="feature">${icon('thermo')}<strong>Auto-Adapt</strong><small>Sensor suhu cerdas</small></div><div class="feature">${icon('fan')}<strong>Ultra Quiet</strong><small>Operasi tanpa suara</small></div></div><div class="onboard-footer"><div class="dots"><button class="dot active" data-action="onboarding-dot" aria-label="Slide 1"></button><button class="dot" data-action="onboarding-dot" aria-label="Slide 2"></button><button class="dot" data-action="onboarding-dot" aria-label="Slide 3"></button></div><button class="btn btn-primary" data-action="next-onboarding">Selanjutnya ${icon('arrow')}</button></div></div></section></div>`;
}

function splash() {
  clearTimeout(splashTimer);
  splashTimer = setTimeout(() => go(state.loggedIn ? 'dashboard' : 'login'), 1900);
  return `<div class="splash"><div class="splash-box"><div class="fan-orb">${icon('fan')}</div><h1>Smart Fan</h1><p>Intelligent Climate Control</p><div class="loading-dots"><i></i><i></i><i></i></div><div class="technical">INITIALIZING SYSTEMS...</div></div></div>`;
}

function login() {
  return `<div class="login-page"><form class="login-card" data-form="login"><div class="login-brand"><div class="fan-orb">${icon('fan')}</div><h1>Selamat Datang Kembali!</h1><p>Log in to manage your Smart Fan settings.</p></div><div class="field"><div class="field-head"><label class="field-label" for="email">EMAIL</label></div><div class="input-wrap">${icon('user')}<input id="email" name="email" type="email" placeholder="Enter your email" required></div></div><div class="field"><div class="field-head"><label class="field-label" for="password">PASSWORD</label><a href="#/login" data-action="forgot">Forgot password?</a></div><div class="input-wrap">${icon('settings')}<input id="password" name="password" type="password" placeholder="Enter your password" required><button type="button" class="icon-btn" data-action="password">${icon('user')}</button></div></div><div id="login-error"></div><button class="btn btn-primary" type="submit">LOG IN ${icon('arrow')}</button><div class="login-footer">Don't have an account? <a href="#/register">Sign up</a></div></form></div>`;
}

function register() {
  return `<div class="login-page"><form class="login-card register-card" data-form="register"><div class="login-brand"><div class="fan-orb">${icon('fan')}</div><h1>Buat Akun</h1><p>Lengkapi data diri untuk membuat akun Smart Fan.</p></div><div class="field"><div class="field-head"><label class="field-label" for="register-name">NAMA LENGKAP</label></div><div class="input-wrap">${icon('user')}<input id="register-name" name="name" type="text" placeholder="Nama lengkap" required></div></div><div class="field"><div class="field-head"><label class="field-label" for="register-nickname">NICKNAME</label></div><div class="input-wrap">${icon('user')}<input id="register-nickname" name="nickname" type="text" placeholder="Nama panggilan" required></div></div><div class="field"><div class="field-head"><label class="field-label" for="register-email">EMAIL</label></div><div class="input-wrap">${icon('user')}<input id="register-email" name="email" type="email" placeholder="nama@email.com" required></div></div><div class="field"><div class="field-head"><label class="field-label" for="register-phone">NOMOR TELEPON</label></div><div class="input-wrap"><input id="register-phone" name="phone" type="tel" placeholder="08xxxxxxxxxx" required></div></div><div class="field"><div class="field-head"><label class="field-label" for="register-gender">JENIS KELAMIN</label></div><select id="register-gender" name="gender" class="form-control" required><option value="" selected disabled>Pilih jenis kelamin</option><option value="Laki-laki">Laki-laki</option><option value="Perempuan">Perempuan</option><option value="Tidak ingin menyebutkan">Tidak ingin menyebutkan</option></select></div><div class="field"><div class="field-head"><label class="field-label" for="register-birth-date">TANGGAL LAHIR</label></div><input id="register-birth-date" name="birthDate" class="form-control" type="date" required></div><div class="field"><div class="field-head"><label class="field-label" for="register-address">ALAMAT</label></div><textarea id="register-address" name="address" class="form-control" placeholder="Alamat lengkap" required style="height:90px;padding:12px 13px;resize:vertical"></textarea></div><div class="field"><div class="field-head"><label class="field-label" for="register-password">PASSWORD</label></div><div class="input-wrap">${icon('settings')}<input id="register-password" name="password" type="password" minlength="6" placeholder="Minimal 6 karakter" required></div></div><button class="btn btn-primary" type="submit">DAFTAR ${icon('arrow')}</button><div class="login-footer">Sudah punya akun? <a href="#/login">Log in</a></div></form></div>`;
}

function statCard(label, value, ico) {
  return `<article class="stat-card"><div class="stat-top"><span class="stat-label">${label}</span>${icon(ico)}</div><strong>${value}</strong></article>`;
}

function toggle(id, on, label = '') {
  return `<button class="toggle ${on?'on':''}" data-action="toggle" data-id="${id}" role="switch" aria-checked="${on}" aria-label="${label||'Ubah status'}"></button>`;
}

function deviceCard(d) {
  const level = Math.max(0, Math.min(5, Math.round(d.speed / 20)));
  const coolingState = d.autoControlled ? ' • Otomatis' : '';
  return `<article class="device-card ${d.power?'':'off'}" data-device="${d.id}"><div class="device-head"><div class="device-icon">${icon('fan')}</div>${toggle(d.id,d.power,`${d.power?'Matikan':'Nyalakan'} kipas ${d.name}`)}</div><h3>${escapeHtml(d.name)}</h3><p><b>${d.temperature.toFixed(1)}°C</b> • ${d.power?`Menyala • Kecepatan ${Math.max(1,Math.round(d.speed/20))}${coolingState}`:'Mati'}</p><div class="level-row"><span>−</span><div class="level-bars">${[1,2,3,4,5].map(i=>`<i class="${i<=level?'on':''}"></i>`).join('')}</div><span>＋</span></div></article>`;
}

function dashboard() {
  const temperature = roomSensorAverage('temperature');
  const power = state.devices.reduce((sum, fan) => sum + (fan.power ? Math.round(fan.speed * 1.35) : 0), 0);
  return shell(`<section class="welcome"><div><div class="eyebrow">${icon(greeting()==='Malam'?'moon':'sun')} SMART HOME / LIVE OVERVIEW</div><h1>Hai, Selamat ${greeting()}, ${escapeHtml(greetingName())}</h1><p><i class="status-dot"></i> &nbsp;Kontrol otomatis aktif per ruangan.</p></div><button class="btn btn-secondary" data-action="refresh">${icon('chart')} Refresh data</button></section><section class="summary-grid">${statCard('SUHU RATA-RATA',`${temperature.toFixed(1)}°C`,'thermo')}${statCard('DAYA TOTAL',`${Math.round(power)}W`,'zap')}</section><section class="content-section"><div class="section-title"><h2>Perangkat Aktif</h2><a href="#/fan-modes">Kelola perangkat ${icon('chevron')}</a></div><div class="device-grid">${state.devices.map(deviceCard).join('')}</div></section>`, `dashboard`, 'Beranda');
}
const ring = value => {
  const r = 112,
    c = 2 * Math.PI * r;
  return `<div class="ring"><svg viewBox="0 0 250 250"><circle class="track" cx="125" cy="125" r="${r}"/><circle class="progress" cx="125" cy="125" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c-(c*value/100)}"/></svg><div class="ring-center"><div><div class="ring-number">${value}<span>%</span></div><span class="ring-label technical">POWER KIPAS</span></div></div></div>`;
};

function fanDetail() {
  const d = device();
  const fanPower = d.power ? d.speed : 0;
  const preset = d.speed >= 95 ? 'turbo' : d.speed >= 70 ? 'high' : d.speed >= 40 ? 'med' : 'low';
  return shell(`<div class="page-heading"><div><div class="eyebrow">DEVICE / ${escapeHtml(d.name)}</div><h1>Detail Kipas</h1><p>Atur sirkulasi udara sesuai ritme ruangan Anda.</p></div><button class="btn btn-secondary" data-action="back">${icon('arrow')} Kembali</button></div><div class="detail-layout"><section class="panel ring-panel">${ring(fanPower)}<div class="status-badge ${d.power?'':'off'}"><i class="status-dot"></i>${d.power?'MENYALA':'MATI'}</div><div class="power-area"><button class="power-button ${d.power?'':'off'}" data-action="power" aria-label="${d.power?'Matikan':'Nyalakan'} kipas">${icon('power')}</button></div></section><div class="control-stack"><section class="panel control-card"><h3>Mode Kecepatan</h3><div class="segmented">${[['low','Low',25],['med','Med',50],['high','High',80],['turbo','Turbo',100]].map(([m,l,v])=>`<button class="${preset===m?'active':''}" data-action="preset" data-mode="${m}" data-value="${v}" ${d.power?'':'disabled'}>${icon('fan')} ${l}</button>`).join('')}</div></section><section class="panel control-card"><div class="control-meta"><h3>Aktivasi</h3><b>${d.activationMode === 'temperature' ? 'Berdasarkan Suhu' : 'Manual'}</b></div><div class="segmented" style="margin-top:12px">${[['manual','Manual'],['temperature','Suhu']].map(([mode, label])=>`<button class="${d.activationMode===mode?'active':''}" data-action="activation-mode" data-mode="${mode}">${label}</button>`).join('')}</div><div class="control-meta" style="margin-top:18px"><span class="technical">AKTIF SAAT SUHU</span><b>${d.temperatureTarget.toFixed(0)}°C</b></div><div class="slider-row">${icon('thermo')}<input class="range" type="range" min="22" max="32" step="1" value="${d.temperatureTarget}" data-action="temperature-target" ${d.activationMode === 'temperature' ? '' : 'disabled'}>${icon('thermo')}</div></section><section class="panel control-card"><div class="control-meta"><h3>Kontrol Halus</h3><b>${d.speed}%</b></div><div class="slider-row">${icon('fan')}<input class="range" type="range" min="0" max="100" value="${d.speed}" data-action="speed" ${d.power?'':'disabled'}>${icon('fan')}</div><div class="control-meta" style="margin-top:24px"><span class="technical">OSILASI</span><b>${d.oscillation}°</b></div><div class="slider-row">${icon('settings')}<input class="range" type="range" min="0" max="180" step="45" value="${d.oscillation}" data-action="oscillation" ${d.power?'':'disabled'}></div></section><div class="mini-grid"><article class="mini-stat">${icon('thermo')}<span class="stat-label">SUHU RUANGAN</span><strong>${d.temperature.toFixed(1)}°C</strong><small class="muted">Target otomatis: ${d.temperatureTarget}°C</small></article></div></div></div>`, `fan-modes`, 'Kipas');
}

function modes() {
  const modes = [
    ['auto_cool', 'fan', 'Auto Cool', 'Menyesuaikan kecepatan kipas untuk mempertahankan suhu ruangan yang sejuk secara konsisten.'],
    ['sleep', 'moon', 'Sleep', 'Kecepatan berkurang bertahap, beroperasi dengan suara minimal0 untuk tidur yang tenang.'],
    ['study', 'book', 'Study', 'Sirkulasi udara stabil dan sunyi, ideal untuk fokus dan konsentrasi.'],
    ['turbo', 'zap', 'Turbo', 'Performa maksimal untuk mendinginkan ruangan dengan cepat dalam waktu singkat.'],
    ['eco', 'leaf', 'Eco', 'Optimalisasi penggunaan energi dengan menyesuaikan putaran kipas secara efisien.']
  ];
  return shell(`<div class="page-heading"><div><div class="eyebrow">SMART PROFILES / AUTOMATION</div><h1>Mode Otomatis</h1><p>Pilih profil cerdas untuk menyesuaikan kecepatan dan sirkulasi kipas secara otomatis berdasarkan kebutuhan spesifik Anda.</p></div></div><div class="mode-grid">${modes.map(([id,ico,title,desc])=>`<article class="mode-card ${state.mode===id?'selected':''}" data-action="select-mode" data-mode="${id}"><div class="mode-icon">${icon(ico)}</div>${state.mode===id?`<span class="mode-check">${icon('check')}</span>`:''}<h3>${title}</h3><p>${desc}</p></article>`).join('')}</div><div style="display:flex;justify-content:flex-end;margin-top:22px"><button class="btn btn-primary" data-action="activate-mode">Aktifkan Mode ${icon('arrow')}</button></div>`, `fan-modes`, 'Kipas');
}

function stats() {
  const items = state.statistics?.items || [];
  const values = items.slice(-7).map(item => Number(item.active_minutes || 0) / 60);
  const total = values.reduce((a, b) => a + b, 0);
  const kwh = items.reduce((sum, item) => sum + Number(item.energy_wh || 0), 0) / 1000;
  const hasHistory = items.length > 0;
  const chart = hasHistory
    ? values.map((value, index) => `<div class="bar-col"><div class="bar ${index === values.length - 1 ? 'highlight' : ''}" style="height:${Math.max(8, (value / Math.max(...values)) * 100)}%" title="${value} jam"></div><label>${['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'][index]}</label></div>`).join('')
    : '<p class="muted">Belum ada riwayat pemakaian kipas.</p>';
  const cost = hasHistory ? rupiah(Math.round(kwh * state.tariff)) : '—';
  return shell(`<div class="page-heading"><div><div class="eyebrow">INSIGHTS / ENERGY</div><h1>Statistik Penggunaan</h1><p>Analisis performa dan efisiensi energi.</p></div><div class="segmented" style="min-width:220px"><button class="${state.range==='day'?'active':''}" data-action="range" data-range="day">Hari</button><button class="${state.range==='week'?'active':''}" data-action="range" data-range="week">Minggu</button><button class="${state.range==='month'?'active':''}" data-action="range" data-range="month">Bulan</button></div></div><div class="stats-layout"><section class="panel chart-card"><span class="stat-label">TOTAL WAKTU AKTIF</span><div class="big-number">${hasHistory ? Math.round(total) : '—'} <small style="font-size:18px;color:var(--text)">Jam</small></div><span class="delta">${hasHistory ? 'Berdasarkan riwayat pemakaian' : 'Belum ada riwayat pemakaian'}</span><div class="section-title" style="margin-top:34px"><h2>Penggunaan Harian</h2><span class="muted">${state.range==='month'?'30 hari':'7 hari'}</span></div><div class="bar-chart">${chart}</div></section><section class="panel metric-card"><div class="metric-block"><h2>Estimasi Listrik</h2><span class="metric-value">${hasHistory ? `${kwh} kWh` : '—'}</span><div class="progress"><i style="width:${hasHistory ? Math.min(100,kwh/60*100) : 0}%"></i></div><div class="metric-foot"><span>Batas optimal: 60 kWh</span><span>${hasHistory ? `${Math.round(kwh/60*100)}%` : '—'}</span></div></div><div class="metric-block"><h2>Estimasi Biaya</h2><span class="metric-title">${hasHistory ? 'Berdasarkan riwayat pemakaian' : 'Menunggu riwayat pemakaian'}</span><span class="metric-value">${cost}</span><div class="cost-box"><span>Tarif dasar</span><b>${rupiah(state.tariff)} / kWh</b><span style="display:block;margin-top:10px">Proyeksi bulanan</span><b>${hasHistory ? rupiah(Math.round(kwh*4.33*state.tariff)) : '—'}</b></div></div></section></div>`, `stats`, 'Statistik');
}

function account() {
  const user = {
    name: '',
    nickname: '',
    email: '',
    phone: '',
    birthDate: '',
    gender: '',
    address: '',
    createdAt: '2025-01-12',
    role: 'Pengguna',
    avatar: '',
    ...state.user
  };
  const initials = (user.name || 'Pengguna').split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const value = fieldName => user[fieldName] || 'Belum diisi';
  const input = (fieldName, type = 'text', required = false) => `<input class="form-control" name="${fieldName}" type="${type}" value="${escapeHtml(user[fieldName]||'')}" ${required?'required':''}>`;
  const field = (label, fieldName, locked = false, type = 'text', required = false) => `<div class="account-field"><span class="field-label">${label}${locked?` ${icon('lock','field-lock')}`:''}</span>${state.accountEditing&&!locked?input(fieldName,type,required):`<strong>${escapeHtml(value(fieldName))}</strong>`}</div>`;
  return shell(`<div class="page-heading"><div><div class="eyebrow">PROFILE / ACCOUNT</div><h1>Akun Saya</h1><p>Kelola informasi profil dan keamanan akun.</p></div></div><form class="account-stack" data-form="account"><section class="panel profile-header-card"><div class="profile-header"><div class="profile-identity"><div class="profile-picture-control"><div class="account-avatar ${user.avatar?'has-image':''}" style="${user.avatar?`background-image:url('${escapeHtml(user.avatar)}')`:''}" data-action="profile-preview" role="button" tabindex="0" aria-label="Tampilkan foto profil"><span>${user.avatar?'':initials}</span><label class="avatar-camera" title="Ubah foto">${icon('camera')}<input type="file" accept="image/*" data-action="avatar"></label></div><span class="profile-picture-hint">Klik foto untuk melihat</span></div><div><h2>${escapeHtml(user.name||'Nama Anda')}</h2><p>@${escapeHtml(user.nickname||'nickname')} · ${escapeHtml(user.email||'email')}</p><span class="member-pill">Member sejak ${formatDate(user.createdAt)}</span></div></div>${!state.accountEditing?`<button type="button" class="btn btn-secondary" data-action="edit-account">${icon('settings')} Edit Profil</button>`:''}</div></section><section class="panel account-card"><div class="account-card-head"><div><span class="eyebrow">ACCOUNT DETAILS</span><h2>Informasi Akun</h2></div><span class="technical muted">${escapeHtml(user.role)}</span></div><div class="account-grid">${field('NAMA LENGKAP','name',false,'text',true)}${field('NICKNAME','nickname')}${field('EMAIL','email',false,'email',true)}${field('NOMOR TELEPON','phone',false,'tel')}${field('TANGGAL LAHIR','birthDate',false,'date')}${field('JENIS KELAMIN','gender')}${field('ALAMAT','address')}${field('TANGGAL MEMBUAT AKUN','createdAt',true)}</div>${state.accountEditing?`<div class="account-actions"><button type="button" class="btn btn-ghost" data-action="cancel-account">Batal</button><button class="btn btn-primary" type="submit">Simpan Perubahan ${icon('check')}</button></div>`:''}</section></form><section class="panel account-card security-card"><div class="account-card-head"><div><span class="eyebrow">SECURITY</span><h2>Keamanan</h2></div></div><button class="security-row" data-action="change-password"><span><strong>Ganti Kata Sandi</strong><small>Perbarui password akun Anda</small></span>${icon('chevron')}</button><button class="security-row logout-row" data-action="logout"><span><strong>Keluar</strong><small>Akhiri sesi di perangkat ini</small></span>${icon('arrow')}</button><div class="danger-zone"><div><strong>Hapus Akun</strong><small>Data akun akan dihapus secara permanen.</small></div><button type="button" class="btn btn-danger" data-action="delete-account">Hapus Akun</button></div></section>`, `account`, 'Akun');
}

function settings() {
  const connectionStatus = state.demo ? 'Mode simulasi aktif' : state.connection.connected ? 'ESP32 terhubung' : 'Belum terhubung';
  return shell(`<div class="page-heading"><div><div class="eyebrow">SYSTEM / PREFERENCES</div><h1>Pengaturan</h1><p>Sesuaikan koneksi, satuan, dan preferensi perangkat.</p></div></div><div class="settings-grid"><form class="panel" style="padding:22px" data-form="connection"><h2 style="font:600 18px 'Plus Jakarta Sans';margin:0 0 6px">Koneksi perangkat</h2><p class="muted" style="margin:0 0 10px">Konfigurasi endpoint ESP32 lokal.</p><div class="field"><label class="field-label" for="esp32-base-url">BASE URL</label><input id="esp32-base-url" name="baseUrl" class="form-control" value="${escapeHtml(state.connection.baseUrl)}" placeholder="http://192.168.1.50" required></div><div class="setting-row"><div><strong>${connectionStatus}</strong><span>Endpoint: ${escapeHtml(state.connection.baseUrl)}</span></div>${toggle('demo',state.demo,'Ubah mode simulasi')}</div><div class="account-actions"><button type="button" class="btn btn-secondary" data-action="test-connection">Uji Koneksi</button><button class="btn btn-primary" type="submit">Simpan Koneksi ${icon('check')}</button></div></form><section class="panel" style="padding:22px"><h2 style="font:600 18px 'Plus Jakarta Sans';margin:0 0 6px">Preferensi</h2><p class="muted" style="margin:0 0 10px">Nilai ini hanya tersimpan di browser.</p><div class="setting-row"><div><strong>Tema tampilan</strong><span>Atur warna latar aplikasi</span></div><div class="segmented theme-switcher"><button type="button" class="${state.theme==='light'?'active':''}" data-action="theme" data-theme="light">Terang</button><button type="button" class="${state.theme==='dark'?'active':''}" data-action="theme" data-theme="dark">Gelap</button></div></div><div class="setting-row"><div><strong>Satuan suhu</strong><span>Gunakan Celsius untuk sensor</span></div><span class="chip active">°C</span></div><div class="setting-row"><div><strong>Tarif listrik</strong><span>Perhitungan estimasi biaya</span></div><input class="form-control" style="width:115px" type="number" value="${state.tariff}" data-action="tariff" aria-label="Tarif listrik"></div></section></div>`, `settings`, 'Pengaturan');
}

function render() {
  const [r, id] = route();
  state.route = r;
  if (r === 'fan' && id) state.selectedDevice = id;
  let html = r === 'onboarding' ? onboarding() : r === 'splash' ? splash() : r === 'login' ? login() : r === 'register' ? register() : !state.loggedIn ? login() : r === 'dashboard' ? dashboard() : r === 'fan' ? fanDetail() : r === 'fan-modes' ? modes() : r === 'stats' ? stats() : r === 'account' ? account() : r === 'settings' ? settings() : dashboard();
  document.querySelector('#app').innerHTML = html;
  const activationCard = document.querySelector('[data-action="activation-mode"]')?.closest('.control-card');
  if (activationCard) {
    const activationMode = device().activationMode;
    activationCard.querySelector('.control-meta b').textContent = activationMode === 'temperature' ? 'Otomatis' : 'Manual';
    const activationButtons = [...activationCard.querySelectorAll('[data-action="activation-mode"]')];
    activationButtons.sort((left, right) => left.dataset.mode === 'temperature' ? -1 : right.dataset.mode === 'temperature' ? 1 : 0);
    activationButtons.forEach(button => {
      button.textContent = button.dataset.mode === 'temperature' ? 'Otomatis' : 'Manual';
      activationCard.querySelector('.segmented').appendChild(button);
    });
    const targetInput = activationCard.querySelector('[data-action="temperature-target"]');
    if (activationMode === 'temperature') {
      targetInput?.parentElement?.previousElementSibling?.remove();
      targetInput?.parentElement?.remove();
    } else if (targetInput) {
      targetInput.disabled = false;
    }
  }
  document.querySelectorAll('.control-meta').forEach(meta => {
    if (meta.textContent.includes('OSILASI')) {
      meta.nextElementSibling?.remove();
      meta.remove();
    }
  });
  persist();
}

function openModal(html) {
  document.body.insertAdjacentHTML('beforeend', html);
  const backdrop = document.querySelector('.modal-backdrop:last-of-type');
  backdrop?.querySelectorAll('.modal-head [data-action="close-modal"], .modal-actions [data-action="close-modal"]').forEach(button => button.addEventListener('click', () => backdrop.remove()));
}

function profilePictureModal() {
  const user = state.user || {};
  const initials = (user.name || 'Pengguna').split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
  const picture = user.avatar
    ? `<img class="profile-picture-preview" src="${escapeHtml(user.avatar)}" alt="Foto profil ${escapeHtml(user.name || 'Pengguna')}">`
    : `<div class="profile-picture-placeholder">${escapeHtml(initials)}</div>`;
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal profile-picture-modal" role="dialog" aria-modal="true" aria-label="Pratinjau foto profil"><div class="profile-picture-heading"><div><span class="eyebrow">PROFILE</span><h2>Foto Profil Anda</h2></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Tutup foto profil">${icon('close')}</button></div><p class="profile-picture-description">Foto profil yang digunakan pada akun Anda.</p>${picture}<button type="button" class="btn btn-primary profile-picture-change" data-action="change-profile-picture">${icon('camera')} Ganti Foto</button></section></div>`;
}

function automaticSpeedForRoom(fan) {
  const difference = Number(fan.temperature) - 25;
  if (difference < 0) return 0;
  return Math.min(100, Math.round(35 + (difference / 6) * 65));
}

function scheduleRunsOnDate(scheduleItem, date) {
  const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  return scheduleItem.days.includes('Setiap Hari') || scheduleItem.days.includes(dayNames[date.getDay()]);
}

function activeScheduleWindow(now = new Date()) {
  const activeWindows = [];
  state.schedules.filter(scheduleItem => scheduleItem.active).forEach(scheduleItem => {
    for (let offset = -7; offset <= 7; offset += 1) {
      const date = new Date(now);
      date.setDate(now.getDate() + offset);
      if (!scheduleRunsOnDate(scheduleItem, date)) continue;
      const [hours, minutes] = scheduleItem.time.split(':').map(Number);
      date.setHours(hours, minutes, 0, 0);
      const end = new Date(date);
      const [offHours, offMinutes] = scheduleItem.offTime.split(':').map(Number);
      end.setHours(offHours, offMinutes, 0, 0);
      if (end <= date) end.setDate(end.getDate() + 1);
      activeWindows.push({ schedule: scheduleItem, start: date, end });
    }
  });
  return activeWindows
    .filter(window => now >= window.start && now < window.end)
    .sort((left, right) => right.start - left.start)[0]?.schedule || null;
}

function applyAutomaticCooling() {
  const schedule = state.mode === 'auto_cool' ? activeScheduleWindow() : null;
  state.devices.forEach(fan => {
    let targetSpeed = 0;
    const previousPower = fan.power;
    const previousSpeed = fan.speed;

    if (fan.activationMode === 'temperature') targetSpeed = automaticSpeedForRoom(fan);

    if (targetSpeed > 0) {
      fan.power = true;
      fan.speed = targetSpeed;
      fan.autoControlled = true;
    } else if (fan.autoControlled) {
      fan.power = false;
      fan.speed = 0;
      fan.autoControlled = false;
    }

    if (fan.activationMode === 'manual' && fan.power !== previousPower && state.mode !== 'auto_cool') {
      fan.autoControlled = false;
    }

    if (fan.power !== previousPower) {
      syncWithEsp32(`/api/fans/${encodeURIComponent(fan.id)}/power`, { on: fan.power });
    }
    if (fan.speed !== previousSpeed && fan.power) {
      syncWithEsp32(`/api/fans/${encodeURIComponent(fan.id)}/control`, {
        speed: fan.speed,
        mode: fan.activationMode === 'temperature' ? 'temperature' : (schedule ? 'auto_cool' : 'manual')
      });
    }
  });
}

function updateAggregateSensors() {
  state.sensors.temperature = roomSensorAverage('temperature');
  state.sensors.humidity = roomSensorAverage('humidity');
  state.sensors.power = state.devices.reduce((sum, fan) => sum + (fan.power ? Math.round(fan.speed * 1.35) : 0), 0);
}

function applyRemoteSensorData(data) {
  const rooms = Array.isArray(data?.rooms)
    ? Object.fromEntries(data.rooms.map(room => [room.id, room]))
    : data?.rooms || data?.sensors?.rooms || {};
  state.devices.forEach(fan => {
    const room = rooms[fan.id];
    if (!room) return;
    if (Number.isFinite(Number(room.temperature))) fan.temperature = Number(room.temperature);
    if (Number.isFinite(Number(room.humidity))) fan.humidity = Number(room.humidity);
  });
  if (data?.sensors && !data.sensors.rooms && Number.isFinite(Number(data.sensors.temperature))) {
    state.devices[0].temperature = Number(data.sensors.temperature);
    state.devices[0].humidity = Number(data.sensors.humidity) || state.devices[0].humidity;
  }
  updateAggregateSensors();
}

async function updateSensor() {
  if (!state.demo) {
    try {
      const data = await esp32Request('/api/status');
      applyRemoteSensorData(data);
      applyAutomaticCooling();
      updateAggregateSensors();
      if (state.route === 'dashboard' || state.route === 'fan') render();
      persist();
    } catch (error) {
      // Connection state is already updated by esp32Request.
    }
    return;
  }
  state.devices.forEach(fan => {
    fan.temperature = Math.max(21, Math.min(35, fan.temperature + (Math.random() - .5) * .35));
    fan.humidity = Math.max(40, Math.min(80, fan.humidity + (Math.random() - .5) * 1.1));
  });
  applyAutomaticCooling();
  updateAggregateSensors();
  if (state.route === 'dashboard' || state.route === 'fan') render();
  persist();
}
document.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  const el = e.target.closest('[data-action]');
  if (action === 'next-onboarding') go('splash');
  if (action === 'onboarding-dot') {
    document.querySelectorAll('.dot').forEach(dot => dot.classList.remove('active'));
    el.classList.add('active');
    toast(`Slide ${[...document.querySelectorAll('.dot')].indexOf(el)+1} dipilih`);
  }
  if (action === 'password') {
    const input = document.querySelector('#password');
    input.type = input.type === 'password' ? 'text' : 'password';
  }
  if (action === 'logout') {
    state.loggedIn = false;
    apiRequest('auth.php?action=logout', { method: 'POST' }).catch(() => {}).finally(() => {
      persist();
      go('login');
    });
  }
  if (action === 'refresh') {
    updateSensor();
    toast('Data sensor diperbarui');
  }
  if (action === 'theme') {
    state.theme = el.dataset.theme === 'light' ? 'light' : 'dark';
    applyTheme();
    apiRequest('settings.php', {
      method: 'PUT',
      body: JSON.stringify({ theme: state.theme })
    }).catch(error => toast(error.message));
    persist();
    render();
    toast(`Tema ${state.theme === 'light' ? 'terang' : 'gelap'} diterapkan`);
  }
  if (action === 'test-connection') {
    const form = document.querySelector('[data-form="connection"]');
    const baseUrl = form?.baseUrl.value.trim().replace(/\/$/, '');
    if (!baseUrl) {
      toast('Masukkan BASE URL ESP32 terlebih dahulu');
    } else {
      try {
        state.connection.baseUrl = new URL(baseUrl).toString().replace(/\/$/, '');
        state.demo = false;
        persist();
        esp32Request('/api/status').then(data => {
          applyRemoteSensorData(data);
          syncSchedulesWithEsp32();
          persist();
          render();
          toast('ESP32 terhubung');
        }).catch(() => toast('ESP32 tidak dapat dihubungi. Periksa URL dan jaringan.'));
      } catch (error) {
        toast('Masukkan URL ESP32 yang valid');
      }
    }
  }
  if (action === 'menu') {
    document.querySelector('.sidebar')?.classList.toggle('open');
  }
  if (action === 'back') go('dashboard');
  if (action === 'power') {
    const d = device();
    d.power = !d.power;
    d.speed = d.power ? Math.max(60, d.speed) : 0;
    d.autoControlled = false;
    persist();
    render();
    syncWithEsp32(`/api/fans/${encodeURIComponent(d.id)}/power`, { on: d.power });
    toast(d.power ? 'Kipas dinyalakan' : 'Kipas dimatikan');
  }
  if (action === 'toggle') {
    e.stopPropagation();
    const id = el.dataset.id;
    if (id === 'eco') {
      device().eco = !device().eco;
      toast(`Eco Mode ${device().eco?'aktif':'nonaktif'}`);
    } else if (id === 'demo') {
      state.demo = !state.demo;
    } else if (el.closest('.schedule-card')) {
      const s = state.schedules.find(x => x.id === id);
      if (s) s.active = !s.active;
    } else {
      const d = state.devices.find(x => x.id === id);
      if (d) {
        d.power = !d.power;
        d.speed = d.power ? Math.max(60, d.speed) : 0;
        d.autoControlled = false;
        syncWithEsp32(`/api/fans/${encodeURIComponent(d.id)}/power`, { on: d.power });
      }
    }
    if (el.closest('.schedule-card')) {
      applyAutomaticCooling();
      syncSchedulesWithEsp32();
    }
    persist();
    render();
  }
  if (action === 'preset') {
    const d = device();
    d.speed = Number(el.dataset.value);
    d.mode = el.dataset.mode;
    d.autoControlled = false;
    persist();
    render();
    syncWithEsp32(`/api/fans/${encodeURIComponent(d.id)}/control`, { speed: d.speed, mode: d.mode });
    toast(`Mode ${el.dataset.mode.toUpperCase()} dipilih`);
  }
  if (action === 'select-mode') {
    state.mode = el.dataset.mode;
    persist();
    render();
  }
  if (action === 'activate-mode') {
    syncWithEsp32('/api/mode', { mode: state.mode });
    toast(`Mode ${state.mode.replace('_',' ')} diaktifkan`);
  }
  if (action === 'activation-mode') {
    const d = device();
    d.activationMode = el.dataset.mode;
    if (d.activationMode === 'manual') {
      d.autoControlled = false;
    }
    syncTemperatureAutomation(d);
    applyAutomaticCooling();
    persist();
    render();
    toast(d.activationMode === 'temperature' ? 'Mode otomatis aktif' : 'Mode manual aktif');
  }
  if (action === 'temperature-target') {
    const d = device();
    d.temperatureTarget = Number(el.value);
    syncTemperatureAutomation(d);
    persist();
    applyAutomaticCooling();
    render();
    toast(`Suhu aktif ${d.temperatureTarget.toFixed(0)}°C`);
  }
  if (action === 'close-modal' && (!el.classList.contains('modal-backdrop') || e.target === el)) {
    document.querySelector('.modal-backdrop')?.remove();
  }
  if (action === 'range') {
    state.range = el.dataset.range;
    loadStatistics(state.range).then(() => render()).catch(error => toast(error.message));
  }
  if (action === 'tariff') {
    state.tariff = Number(el.value) || 1444;
    persist();
  }
});
document.addEventListener('click', e => {
  const card = e.target.closest('.device-card');
  if (card && !e.target.closest('[data-action="toggle"]')) {
    state.selectedDevice = card.dataset.device;
    go(`fan/${card.dataset.device}`);
  }
});
document.addEventListener('click', e => {
  const bar = e.target.closest('.bar-col');
  if (!bar) return;
  document.querySelectorAll('.bar-col.selected').forEach(item => item.classList.remove('selected'));
  bar.classList.add('selected');
  const value = bar.querySelector('.bar')?.title || '';
  const label = bar.querySelector('label')?.textContent || 'Hari dipilih';
  toast(`${label}: ${value}`);
});
document.addEventListener('input', e => {
  if (e.target.dataset.action === 'speed') {
    device().speed = Number(e.target.value);
    persist();
    syncWithEsp32(`/api/fans/${encodeURIComponent(device().id)}/control`, { speed: device().speed });
    const n = e.target.closest('.control-card')?.querySelector('.control-meta b');
    if (n) n.textContent = `${device().speed}%`;
    const p = e.target.closest('.detail-layout')?.querySelector('.progress');
    if (p) {
      const c = 2 * Math.PI * 112;
      p.style.strokeDashoffset = c - (c * device().speed / 100)
    }
    const ringNumber = e.target.closest('.detail-layout')?.querySelector('.ring-number');
    if (ringNumber) ringNumber.innerHTML = `${device().power ? device().speed : 0}<span>%</span>`;
  }
  if (e.target.dataset.action === 'oscillation') {
    device().oscillation = Number(e.target.value);
    persist();
    syncWithEsp32(`/api/fans/${encodeURIComponent(device().id)}/control`, { oscillation: device().oscillation });
    render();
  }
  if (e.target.dataset.action === 'tariff') {
    state.tariff = Number(e.target.value) || 1444;
    apiRequest('settings.php', {
      method: 'PUT',
      body: JSON.stringify({ electricity_tariff: state.tariff })
    }).catch(error => toast(error.message));
    persist();
  }
});
document.addEventListener('change', e => {
  if (e.target.matches('input[type="checkbox"][name="days"]')) e.target.parentElement.classList.toggle('active', e.target.checked);
});

function passwordModal() {
  return `<div class="modal-backdrop"><form class="modal" data-form="password"><div class="modal-head"><h2>Ganti Kata Sandi</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Tutup modal">${icon('close')}</button></div><div class="field"><label class="field-label">KATA SANDI LAMA</label><input class="form-control" name="current" type="password" required></div><div class="field"><label class="field-label">KATA SANDI BARU</label><input class="form-control" name="next" type="password" minlength="6" required></div><div class="field"><label class="field-label">KONFIRMASI KATA SANDI</label><input class="form-control" name="confirm" type="password" minlength="6" required></div><div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Batal</button><button class="btn btn-primary" type="submit">Simpan ${icon('check')}</button></div></form></div>`;
}

function deleteModal() {
  return `<div class="modal-backdrop"><form class="modal" data-form="delete-account"><div class="modal-head"><h2>Hapus Akun?</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="Tutup modal">${icon('close')}</button></div><p class="muted">Tindakan ini permanen dan tidak dapat dibatalkan. Semua data profil akan dihapus dari perangkat ini.</p><div class="modal-actions"><button type="button" class="btn btn-ghost" data-action="close-modal">Batal</button><button class="btn btn-danger" type="submit">Hapus Permanen</button></div></form></div>`;
}
document.addEventListener('click', e => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'profile-preview' && !e.target.closest('.avatar-camera')) {
    openModal(profilePictureModal());
    return;
  }
  if (action === 'change-profile-picture') {
    document.querySelector('[data-action="avatar"]')?.click();
    document.querySelector('.profile-picture-modal')?.closest('.modal-backdrop')?.remove();
    return;
  }
  if (action === 'edit-account') {
    state.accountEditing = true;
    render();
  }
  if (action === 'cancel-account') {
    state.accountEditing = false;
    render();
  }
  if (action === 'change-password') openModal(passwordModal());
  if (action === 'delete-account') openModal(deleteModal());
  if (action === 'close-modal') {
    const backdrop = e.target.closest('.modal-backdrop');
    const closeButton = e.target.closest('.modal-head [data-action="close-modal"], .modal-actions [data-action="close-modal"]');
    if (backdrop && (e.target === backdrop || closeButton)) backdrop.remove();
  }
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-action="profile-preview"]')) {
    e.preventDefault();
    openModal(profilePictureModal());
  }
});
document.addEventListener('change', e => {
  if (e.target.dataset.action !== 'avatar' || !e.target.files[0]) return;
  const reader = new FileReader();
  reader.onload = () => {
    apiRequest('profile.php', {
      method: 'PUT',
      body: JSON.stringify({ avatar: reader.result })
    }).then(() => {
      state.user.avatar = reader.result;
      persist();
      render();
      toast('Foto profil diperbarui');
    }).catch(error => toast(error.message));
  };
  reader.readAsDataURL(e.target.files[0]);
});
document.addEventListener('submit', async e => {
  if (e.target.dataset.form === 'connection') {
    e.preventDefault();
    const baseUrl = e.target.baseUrl.value.trim().replace(/\/$/, '');
    try {
      state.connection.baseUrl = new URL(baseUrl).toString().replace(/\/$/, '');
      state.connection.connected = false;
      await apiRequest('settings.php', {
        method: 'PUT',
        body: JSON.stringify({ esp32_url: state.connection.baseUrl })
      });
      persist();
      render();
      toast('Konfigurasi perangkat disimpan');
    } catch (error) {
      toast(error.message || 'Masukkan URL perangkat yang valid');
    }
    return;
  }
  if (e.target.dataset.form !== 'register') return;
  e.preventDefault();
  const form = e.target;
  const data = {
    name: form.name.value.trim(),
    nickname: form.nickname.value.trim(),
    email: form.email.value.trim(),
    phone: form.phone.value.trim(),
    gender: form.gender.value,
    birthDate: form.birthDate.value,
    address: form.address.value.trim(),
    password: form.password.value
  };

  try {
    const response = await fetch(`${API_BASE}auth.php?action=register`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (!result.success) {
      toast(result.message || 'Registrasi gagal');
      return;
    }

    state.user = {
      id: result.data.id,
      name: data.name,
      nickname: data.nickname,
      email: data.email,
      phone: data.phone,
      gender: data.gender,
      birthDate: data.birthDate,
      address: data.address,
      role: 'Pengguna',
      avatar: ''
    };

    state.loggedIn = true;
    state.demo = false;

    try {
      await loadBackendData();
    } catch (error) {
      console.error('Gagal memuat data setelah login:', error);
      toast(`Login berhasil, tetapi data belum termuat: ${error.message}`);
    }
    persist();
    go('dashboard');

    toast('Akun berhasil dibuat');
  } catch (error) {
    console.error(error);
    toast('Tidak dapat terhubung ke database');
  }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  if (e.target.dataset.form !== 'login') return;

  const form = e.target;
  const email = form.email.value.trim();
  const password = form.password.value;
  const error = document.querySelector('#login-error');

  if (!email || !password) {
    error.innerHTML = '<div class="error">Email dan password wajib diisi.</div>';
    return;
  }

  try {
    const response = await fetch(`${API_BASE}auth.php?action=login`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        password
      })
    });

    const result = await response.json();

    if (!result.success) {
      error.textContent = result.message;
      return;
    }

    state.user = {
      id: result.data.id,
      name: result.data.name,
      nickname: result.data.nickname,
      email: result.data.email,
      phone: result.data.phone,
      gender: result.data.gender,
      birthDate: result.data.birth_date,
      address: result.data.address,
      role: result.data.role,
      avatar: result.data.avatar
    };

    state.loggedIn = true;
    state.demo = false;

    await loadBackendData();
    persist();
    go('dashboard');

    toast('Selamat datang kembali');
  } catch (requestError) {
    console.error(requestError);
    error.textContent = requestError.message || 'Database tidak dapat dihubungi.';
  }
});
document.addEventListener('submit', async e => {
  if (e.target.dataset.form === 'account') {
    e.preventDefault();
    const form = e.target;
    const profile = {
      name: form.name.value.trim(),
      nickname: form.nickname.value.trim(),
      email: form.email.value.trim(),
      phone: form.phone.value.trim(),
      birth_date: form.birthDate.value,
      gender: form.gender.value,
      address: form.address.value.trim()
    };
    if (!profile.name || !profile.email || !profile.email.includes('@')) {
      toast('Nama dan email wajib diisi dengan benar');
      return;
    }
    try {
      await apiRequest('profile.php', { method: 'PUT', body: JSON.stringify(profile) });
      state.user = { ...state.user, ...profile, birthDate: profile.birth_date };
      state.accountEditing = false;
      persist();
      render();
      toast('Perubahan profil disimpan');
    } catch (error) {
      toast(error.message);
    }
  }
  if (e.target.dataset.form === 'password') {
    e.preventDefault();
    const form = e.target;
    if (form.next.value.length < 6) {
      toast('Kata sandi baru minimal 6 karakter');
      return;
    }
    if (form.next.value !== form.confirm.value) {
      toast('Konfirmasi kata sandi tidak cocok');
      return;
    }
    try {
      await apiRequest('profile.php?action=password', {
        method: 'PUT',
        body: JSON.stringify({ old_password: form.current.value, new_password: form.next.value })
      });
      form.closest('.modal-backdrop').remove();
      toast('Kata sandi berhasil diperbarui');
    } catch (error) {
      toast(error.message);
    }
  }
  if (e.target.dataset.form === 'delete-account') {
    e.preventDefault();
    state.loggedIn = false;
    localStorage.removeItem('smartfan_state');
    go('login');
  }
});
window.addEventListener('hashchange', render);
window.addEventListener('load', async () => {
  if (!location.hash) go('onboarding');
  else if (state.loggedIn) {
    try {
      await loadBackendData();
      render();
    } catch (error) {
      state.loggedIn = false;
      persist();
      go('login');
    }
  } else render();
  setInterval(updateSensor, 3500);
});