// Estación de asistencia por EVENTO — pistola USB + cámara + pase de lista en vivo.

const scanEl = document.getElementById("scan");
const fbEl = document.getElementById("feedback");
const evSel = document.getElementById("evento-sel");
const panel = document.getElementById("panel");
const sinEvento = document.getElementById("sin-evento");

let eventoId = null;

// -------- Cargar eventos en el selector ------------------------------------
async function cargarEventos() {
  const d = await (await fetch("/api/eventos")).json();
  if (!d.eventos.length) {
    panel.style.display = "none";
    sinEvento.style.display = "block";
    evSel.innerHTML = "";
    return;
  }
  sinEvento.style.display = "none";
  panel.style.display = "block";
  const guardado = localStorage.getItem("evento_id");
  evSel.innerHTML = d.eventos.map(e => {
    const f = e.fecha ? " · " + e.fecha : "";
    const tipo = e.tipo ? " (" + e.tipo + ")" : "";
    return `<option value="${e.id}">${escapeHtml(e.nombre)}${escapeHtml(tipo)}${escapeHtml(f)} — ${e.asistieron}/${e.invitados}</option>`;
  }).join("");
  // Mantener la selección previa si sigue existiendo.
  if (guardado && d.eventos.some(e => String(e.id) === guardado)) {
    evSel.value = guardado;
  }
  eventoId = parseInt(evSel.value, 10);
  cargarRoster();
}

evSel.addEventListener("change", () => {
  eventoId = parseInt(evSel.value, 10);
  localStorage.setItem("evento_id", String(eventoId));
  cargarRoster();
  refocus();
});

// -------- Beep --------------------------------------------------------------
let audioCtx;
function beep(ok) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = ok ? 880 : 300;
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
    o.start(); o.stop(audioCtx.currentTime + 0.18);
  } catch (e) {}
}

// -------- Foco en el input (clave para la pistola lectora) ------------------
const readyEl = document.getElementById("ready");
const readyTxt = document.getElementById("ready-txt");
function setReady(on) {
  readyEl.className = "ready " + (on ? "on" : "off");
  readyTxt.textContent = on
    ? "Lector listo — dispara la pistola al gafete"
    : "Toca aquí para activar el lector";
}
function refocus() { if (scanEl) scanEl.focus(); }
scanEl.addEventListener("focus", () => setReady(true));
scanEl.addEventListener("blur", () => { setReady(false); setTimeout(refocus, 40); });
document.addEventListener("click", (e) => {
  if (!e.target.closest("button") && !e.target.closest("input") &&
      !e.target.closest("select") && !e.target.closest("a")) refocus();
});
refocus();

// -------- Enviar código -----------------------------------------------------
let enviando = false;
async function enviarCodigo(codigo) {
  codigo = (codigo || "").trim();
  if (!codigo || enviando) return;
  if (!eventoId) { mostrarFeedback({ ok: false, mensaje: "Selecciona un evento primero" }); return; }
  enviando = true;
  try {
    const r = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo, evento_id: eventoId }),
    });
    const data = await r.json();
    mostrarFeedback(data);
    beep(!!data.ok);
    cargarRoster();
  } catch (e) {
    mostrarFeedback({ ok: false, mensaje: "Error de conexión" });
    beep(false);
  } finally {
    enviando = false;
    refocus();
  }
}

scanEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const val = scanEl.value;
    scanEl.value = "";
    enviarCodigo(val);
  }
});

// -------- Feedback visual ---------------------------------------------------
let fbTimer;
function mostrarFeedback(d) {
  clearTimeout(fbTimer);
  fbEl.className = "feedback";
  let html;
  if (d.ok && d.provisional) {
    // Gafete desconocido: se registró, pero hay que capturar sus datos.
    fbEl.classList.add("dup");
    html = `<div class="big">⚠ SIN DATOS · ${d.hora}</div>
            <div class="name">${escapeHtml(d.codigo)}</div>
            <div class="sub">Registrado en pendientes — captura sus datos en Empleados</div>`;
  } else if (d.ok) {
    fbEl.classList.add("entrada");
    const badge = d.invitado ? "" : ' <span class="pill">no convocado</span>';
    const veces = d.veces > 1 ? `Asistencia #${d.veces}` : "Primera asistencia";
    html = `<div class="big">✓ REGISTRADO · ${d.hora}</div>
            <div class="name">${escapeHtml(d.nombre)}${badge}</div>
            <div class="sub">${veces}</div>`;
  } else if (d.duplicado) {
    fbEl.classList.add("dup");
    html = `<div class="big">Lectura repetida</div>
            <div class="name">${escapeHtml(d.nombre || "")}</div>
            <div class="sub">${escapeHtml(d.mensaje || "")}</div>`;
  } else {
    fbEl.classList.add("err");
    html = `<div class="big">Atención</div><div class="sub">${escapeHtml(d.mensaje || "")}</div>`;
  }
  fbEl.innerHTML = html;
  fbTimer = setTimeout(() => {
    fbEl.className = "feedback";
    fbEl.innerHTML = `<div class="idle">Esperando escaneo…</div>`;
  }, 4500);
}

// -------- Roster en vivo ----------------------------------------------------
async function cargarRoster() {
  if (!eventoId) return;
  try {
    const d = await (await fetch(`/api/eventos/${eventoId}/estado`)).json();
    if (d.ok === false) return;
    const r = d.resumen;
    document.getElementById("st-invitados").textContent = r.invitados;
    document.getElementById("st-presentes").textContent = r.presentes;
    document.getElementById("st-ausentes").textContent = r.ausentes;
    document.getElementById("st-walkins").textContent = r.extras;

    const pres = d.invitados.filter(p => p.presente);
    const falt = d.invitados.filter(p => !p.presente);
    document.getElementById("c-pres").textContent = pres.length;
    document.getElementById("c-falt").textContent = falt.length;

    document.getElementById("lista-pres").innerHTML = pres.length
      ? pres.map(p => personaHtml(p, true)).join("")
      : `<div class="muted" style="padding:8px">Nadie ha llegado aún.</div>`;
    document.getElementById("lista-falt").innerHTML = falt.length
      ? falt.map(p => personaHtml(p, false)).join("")
      : `<div class="muted" style="padding:8px">¡Todos presentes! 🎉</div>`;

    // Asistieron sin convocar pero están en la base (reconocidos).
    const rw = document.getElementById("recon-wrap");
    if (d.reconocidos.length) {
      rw.style.display = "block";
      document.getElementById("c-recon").textContent = d.reconocidos.length;
      document.getElementById("lista-recon").innerHTML =
        d.reconocidos.map(p => personaHtml(p, true)).join("");
    } else { rw.style.display = "none"; }

    // Gafetes desconocidos (sin datos) — apartado separado.
    const sw = document.getElementById("sind-wrap");
    if (d.sin_datos.length) {
      sw.style.display = "block";
      document.getElementById("c-sind").textContent = d.sin_datos.length;
      document.getElementById("lista-sind").innerHTML =
        d.sin_datos.map(p => sinDatoHtml(p)).join("");
    } else { sw.style.display = "none"; }
  } catch (e) {}
}
function personaHtml(p, pres) {
  const veces = pres ? `<span class="veces">${p.veces}×</span>` : "";
  const hora = p.ultima ? `<span class="meta">${p.ultima.substring(11,16)}</span>` : "";
  return `<div class="person ${pres ? "pres" : ""}">
    <span class="nm">${escapeHtml(p.nombre)}</span>${hora}${veces}
  </div>`;
}
function sinDatoHtml(p) {
  const hora = p.ultima ? `<span class="meta">${p.ultima.substring(11,16)}</span>` : "";
  return `<div class="person" style="border-color:rgba(245,158,11,.5)">
    <span class="nm">⚠ ${escapeHtml(p.codigo)}</span>
    <span class="meta">sin datos</span>${hora}
    <span class="veces" style="background:rgba(245,158,11,.2);color:#fbbf24">${p.veces}×</span>
  </div>`;
}
setInterval(cargarRoster, 8000);

// -------- Cámara (html5-qrcode) --------------------------------------------
let html5Qrcode = null;
let camActiva = false;
let ultimoCam = { codigo: "", t: 0 };
const camBtn = document.getElementById("cam-toggle");
const readerDiv = document.getElementById("reader");

function qrboxFn(vw) {
  const w = Math.max(160, Math.min(320, Math.floor(vw * 0.85)));
  return { width: w, height: Math.round(w * 0.55) };
}
function onDecode(texto) {
  const now = Date.now();
  if (texto === ultimoCam.codigo && now - ultimoCam.t < 2500) return;
  ultimoCam = { codigo: texto, t: now };
  enviarCodigo(texto);
}
function camConfig() {
  const cfg = { fps: 10, qrbox: qrboxFn, aspectRatio: 1.4 };
  if (typeof Html5QrcodeSupportedFormats !== "undefined") {
    cfg.formatsToSupport = [
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.QR_CODE,
    ];
  }
  return cfg;
}
camBtn.addEventListener("click", async () => {
  if (camActiva) { await detenerCam(); return; }
  if (typeof Html5Qrcode === "undefined") {
    mostrarFeedback({ ok: false, mensaje: "No cargó la librería de cámara" });
    return;
  }
  readerDiv.style.display = "block";
  html5Qrcode = html5Qrcode || new Html5Qrcode("reader");
  const config = camConfig();
  try {
    await html5Qrcode.start({ facingMode: "environment" }, config, onDecode, () => {});
  } catch (e1) {
    try {
      const cams = await Html5Qrcode.getCameras();
      if (!cams || !cams.length) throw e1;
      const trasera = cams.find(c => /back|rear|environment|trase/i.test(c.label || "")) || cams[cams.length - 1];
      await html5Qrcode.start(trasera.id, config, onDecode, () => {});
    } catch (e2) {
      const msg = (e2 && e2.message) ? e2.message : String(e2);
      mostrarFeedback({ ok: false, mensaje: "Cámara: " + msg });
      readerDiv.style.display = "none";
      return;
    }
  }
  camActiva = true;
  camBtn.textContent = "⏹ Detener cámara";
  readerDiv.scrollIntoView({ behavior: "smooth", block: "center" });
});
async function detenerCam() {
  try { await html5Qrcode.stop(); await html5Qrcode.clear(); } catch (e) {}
  camActiva = false;
  camBtn.textContent = "📷 ¿Sin pistola? Usar cámara";
  readerDiv.innerHTML = "";
  readerDiv.style.display = "none";
  refocus();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

cargarEventos();
setInterval(cargarEventos, 30000);
