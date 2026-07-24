// Estación de asistencia — lógica de escaneo (lector USB + cámara).

const scanEl = document.getElementById("scan");
const fbEl = document.getElementById("feedback");
const tbody = document.getElementById("tbody");

// -------- Config / branding -------------------------------------------------
fetch("/api/config").then(r => r.json()).then(cfg => {
  if (cfg.empresa) document.title = cfg.empresa + " — Asistencia";
});

// -------- Beep (WebAudio, sin archivos) -------------------------------------
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
  } catch (e) { /* silencioso */ }
}

// -------- Mantener el foco en el input (clave para la pistola lectora) -------
const readyEl = document.getElementById("ready");
const readyTxt = document.getElementById("ready-txt");
function setReady(on) {
  readyEl.className = "ready " + (on ? "on" : "off");
  readyTxt.textContent = on
    ? "Lector listo — dispara la pistola al gafete"
    : "Toca aquí para activar el lector";
}
function refocus() { scanEl.focus(); }
scanEl.addEventListener("focus", () => setReady(true));
scanEl.addEventListener("blur", () => { setReady(false); setTimeout(refocus, 40); });
document.addEventListener("click", (e) => {
  if (!e.target.closest("button") && !e.target.closest("input")) refocus();
});
refocus();

// -------- Enviar código -----------------------------------------------------
let enviando = false;
async function enviarCodigo(codigo) {
  codigo = (codigo || "").trim();
  if (!codigo || enviando) return;
  enviando = true;
  try {
    const r = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codigo }),
    });
    const data = await r.json();
    mostrarFeedback(data);
    beep(!!data.ok);
    cargarTablaYStats();
  } catch (e) {
    mostrarFeedback({ ok: false, mensaje: "Error de conexión" });
    beep(false);
  } finally {
    enviando = false;
    refocus();
  }
}

// Enter = fin de lectura (el lector USB envía Enter automáticamente).
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
  if (d.ok) {
    fbEl.classList.add(d.tipo === "entrada" ? "entrada" : "salida");
    const extra = d.horas_sesion != null
      ? `Sesión: ${d.horas_sesion} h · Día: ${d.horas_dia} h`
      : `Día: ${d.horas_dia} h`;
    html = `<div class="big">${d.tipo === "entrada" ? "✓ ENTRADA" : "✓ SALIDA"} · ${d.hora}</div>
            <div class="name">${escapeHtml(d.nombre)}</div>
            <div class="sub">${extra}</div>`;
  } else if (d.duplicado) {
    fbEl.classList.add("dup");
    html = `<div class="big">Lectura repetida</div>
            <div class="name">${escapeHtml(d.nombre || "")}</div>
            <div class="sub">${escapeHtml(d.mensaje || "")}</div>`;
  } else {
    fbEl.classList.add("err");
    html = `<div class="big">Error</div><div class="sub">${escapeHtml(d.mensaje || "")}</div>`;
  }
  fbEl.innerHTML = html;
  fbTimer = setTimeout(() => {
    fbEl.className = "feedback";
    fbEl.innerHTML = `<div class="idle">Esperando escaneo…</div>`;
  }, 4500);
}

// -------- Tabla + stats -----------------------------------------------------
async function cargarTablaYStats() {
  try {
    const d = await (await fetch("/api/registros/hoy")).json();
    document.getElementById("st-presentes").textContent = d.presentes;
    document.getElementById("st-registros").textContent = d.total_registros;
    document.getElementById("st-horas").textContent = d.horas_totales;
    if (!d.registros.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">Sin registros aún.</td></tr>`;
      return;
    }
    tbody.innerHTML = d.registros.map(r => {
      const hora = r.ts.substring(11, 19);
      const horas = r.horas != null ? `${r.horas} h` : "—";
      return `<tr>
        <td>${hora}</td>
        <td>${escapeHtml(r.nombre)}</td>
        <td><span class="tag ${r.tipo}">${r.tipo}</span></td>
        <td>${horas}</td>
      </tr>`;
    }).join("");
  } catch (e) { /* silencioso */ }
}
cargarTablaYStats();
setInterval(cargarTablaYStats, 10000);

// -------- Cámara (html5-qrcode) --------------------------------------------
let html5Qrcode = null;
let camActiva = false;
let ultimoCam = { codigo: "", t: 0 };
const camBtn = document.getElementById("cam-toggle");
const readerDiv = document.getElementById("reader");

// qrbox adaptable al tamaño real del video (evita el error "qrbox > video").
function qrboxFn(vw) {
  const w = Math.max(160, Math.min(320, Math.floor(vw * 0.85)));
  return { width: w, height: Math.round(w * 0.55) };
}

function onDecode(texto) {
  const now = Date.now();
  // Evita disparos repetidos del mismo código por la cámara.
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
  // El contenedor DEBE estar visible antes de start() o el video mide 0px.
  readerDiv.style.display = "block";
  html5Qrcode = html5Qrcode || new Html5Qrcode("reader");
  const config = camConfig();
  try {
    await html5Qrcode.start({ facingMode: "environment" }, config, onDecode, () => {});
  } catch (e1) {
    // Fallback: elegir explícitamente una cámara (trasera si se puede).
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
