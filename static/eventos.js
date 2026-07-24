// Página de Eventos: crear (con invitados), histórico y detalle.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// -------- Checklist de empleados -------------------------------------------
let empleados = [];
let seleccion = new Set();
const checklist = document.getElementById("checklist");

async function cargarEmpleados() {
  const d = await (await fetch("/api/empleados")).json();
  empleados = d.empleados;
  renderChecklist("");
}
function renderChecklist(filtro) {
  const f = filtro.toLowerCase();
  const items = empleados.filter(e =>
    e.nombre.toLowerCase().includes(f) || e.codigo.toLowerCase().includes(f));
  checklist.innerHTML = items.length ? items.map(e => `
    <label class="checkrow">
      <input type="checkbox" value="${escapeHtml(e.codigo)}" ${seleccion.has(e.codigo) ? "checked" : ""}>
      <span class="nm">${escapeHtml(e.nombre)}</span>
      <span class="ar">${escapeHtml(e.area || "")}</span>
    </label>`).join("") : `<div class="muted" style="padding:10px">Sin empleados. Agrégalos en la pestaña Empleados.</div>`;
  checklist.querySelectorAll("input").forEach(cb => {
    cb.addEventListener("change", () => {
      if (cb.checked) seleccion.add(cb.value); else seleccion.delete(cb.value);
      actualizarConteo();
    });
  });
}
function actualizarConteo() {
  document.getElementById("sel-count").textContent = seleccion.size + " seleccionados";
}
document.getElementById("e-buscar").addEventListener("input", e => renderChecklist(e.target.value));
document.getElementById("sel-todos").addEventListener("click", () => {
  empleados.forEach(e => seleccion.add(e.codigo));
  renderChecklist(document.getElementById("e-buscar").value); actualizarConteo();
});
document.getElementById("sel-ninguno").addEventListener("click", () => {
  seleccion.clear();
  renderChecklist(document.getElementById("e-buscar").value); actualizarConteo();
});

// -------- Crear evento ------------------------------------------------------
document.getElementById("crear").addEventListener("click", async () => {
  const body = {
    nombre: document.getElementById("e-nombre").value,
    tipo: document.getElementById("e-tipo").value,
    detalles: document.getElementById("e-detalles").value,
    fecha: document.getElementById("e-fecha").value,
    invitados: Array.from(seleccion),
  };
  const msg = document.getElementById("crear-msg");
  if (!body.nombre.trim()) { msg.textContent = "Falta el nombre"; msg.style.color = "#f87171"; return; }
  const d = await (await fetch("/api/eventos", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  if (d.ok) {
    msg.textContent = "Evento creado ✓"; msg.style.color = "#4ade80";
    document.getElementById("e-nombre").value = "";
    document.getElementById("e-tipo").value = "";
    document.getElementById("e-detalles").value = "";
    document.getElementById("e-fecha").value = "";
    seleccion.clear(); renderChecklist(""); actualizarConteo();
    cargarEventos();
  } else {
    msg.textContent = d.mensaje || "Error"; msg.style.color = "#f87171";
  }
  setTimeout(() => { msg.textContent = ""; }, 3000);
});

// -------- Histórico ---------------------------------------------------------
async function cargarEventos() {
  const d = await (await fetch("/api/eventos")).json();
  const cont = document.getElementById("lista-eventos");
  if (!d.eventos.length) { cont.innerHTML = `<div class="muted">Aún no hay eventos.</div>`; return; }
  cont.innerHTML = d.eventos.map(e => {
    const meta = [e.tipo, e.fecha].filter(Boolean).map(escapeHtml).join(" · ");
    return `<div class="evcard" data-id="${e.id}" style="cursor:pointer">
      <div class="info">
        <div class="t">${escapeHtml(e.nombre)}</div>
        <div class="d">${meta || "Sin fecha"}</div>
      </div>
      <div class="nums">
        <div><div class="n">${e.asistieron}</div><div class="l">Asist.</div></div>
        <div><div class="n">${e.invitados}</div><div class="l">Invit.</div></div>
      </div>
    </div>`;
  }).join("");
  cont.querySelectorAll(".evcard").forEach(c =>
    c.addEventListener("click", () => abrirDetalle(parseInt(c.dataset.id, 10))));
}

// -------- Detalle (modal) ---------------------------------------------------
let eventoActual = null;
const modal = document.getElementById("modal");

async function abrirDetalle(id) {
  eventoActual = id;
  const d = await (await fetch(`/api/eventos/${id}/estado`)).json();
  const ev = d.evento, r = d.resumen;
  document.getElementById("m-titulo").textContent = ev.nombre;
  document.getElementById("m-info").innerHTML =
    [ev.tipo, ev.fecha, ev.detalles].filter(Boolean).map(escapeHtml).join(" · ") || "Sin detalles";
  document.getElementById("m-inv").textContent = r.invitados;
  document.getElementById("m-pres").textContent = r.presentes;
  document.getElementById("m-aus").textContent = r.ausentes;
  document.getElementById("m-walk").textContent = r.walkins;
  document.getElementById("m-export").href = `/api/eventos/${id}/export.csv`;

  const roster = d.invitados.map(p => personaRow(p, id, true))
    .concat(d.walkins.map(p => personaRow(p, id, false, true)));
  document.getElementById("m-roster").innerHTML = roster.length
    ? roster.join("") : `<div class="muted" style="padding:8px">Sin invitados. Agrega abajo.</div>`;
  bindQuitar(id);
  modal.classList.add("open");
}
function personaRow(p, id, esInvitado, walkin) {
  const estado = p.presente
    ? `<span class="veces">${p.veces}×</span>`
    : `<span class="meta">falta</span>`;
  const tag = walkin ? ` <span class="pill">no invitado</span>` : "";
  const quitar = esInvitado
    ? `<button class="iconbtn quitar" data-cod="${escapeHtml(p.codigo)}" title="Quitar del evento">✕</button>` : "";
  return `<div class="person ${p.presente ? "pres" : ""}">
    <span class="nm">${escapeHtml(p.nombre)}${tag}</span>${estado}${quitar}
  </div>`;
}
function bindQuitar(id) {
  document.querySelectorAll("#m-roster .quitar").forEach(b =>
    b.addEventListener("click", async () => {
      await fetch(`/api/eventos/${id}/invitados/${encodeURIComponent(b.dataset.cod)}`, { method: "DELETE" });
      abrirDetalle(id); cargarEventos();
    }));
}
document.getElementById("cerrar").addEventListener("click", () => modal.classList.remove("open"));
modal.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });

document.getElementById("m-usar").addEventListener("click", () => {
  if (eventoActual) localStorage.setItem("evento_id", String(eventoActual));
});
document.getElementById("m-add").addEventListener("click", async () => {
  const cod = document.getElementById("m-addcod").value.trim();
  if (!cod || !eventoActual) return;
  await fetch(`/api/eventos/${eventoActual}/invitados`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ codigos: [cod] }),
  });
  document.getElementById("m-addcod").value = "";
  abrirDetalle(eventoActual); cargarEventos();
});
document.getElementById("m-borrar").addEventListener("click", async () => {
  if (!eventoActual) return;
  if (!confirm("¿Eliminar este evento y su asistencia? No se puede deshacer.")) return;
  await fetch(`/api/eventos/${eventoActual}`, { method: "DELETE" });
  modal.classList.remove("open");
  cargarEventos();
});

cargarEmpleados();
cargarEventos();
