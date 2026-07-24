// Página de Empleados: alta/edición, eliminar, buscar, exportar.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

let empleados = [];

async function cargar() {
  const d = await (await fetch("/api/empleados")).json();
  empleados = d.empleados;
  document.getElementById("total").textContent = empleados.length;
  render(document.getElementById("buscar").value);
}

function render(filtro) {
  const f = (filtro || "").toLowerCase();
  const items = empleados.filter(e =>
    e.nombre.toLowerCase().includes(f) || e.codigo.toLowerCase().includes(f) ||
    (e.area || "").toLowerCase().includes(f));
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = items.length ? items.map(e => `
    <tr>
      <td>${escapeHtml(e.codigo)}</td>
      <td style="cursor:pointer" onclick="editar('${escapeHtml(e.codigo)}','${escapeHtml(e.nombre)}','${escapeHtml(e.area || "")}')">${escapeHtml(e.nombre)}</td>
      <td class="muted">${escapeHtml(e.area || "")}</td>
      <td><button class="iconbtn" title="Eliminar" onclick="borrar('${escapeHtml(e.codigo)}','${escapeHtml(e.nombre)}')">🗑</button></td>
    </tr>`).join("") : `<tr><td colspan="4" class="muted">Sin resultados.</td></tr>`;
}

document.getElementById("buscar").addEventListener("input", e => render(e.target.value));

window.editar = function (codigo, nombre, area) {
  document.getElementById("e-codigo").value = codigo;
  document.getElementById("e-nombre").value = nombre.startsWith("Sin nombre") ? "" : nombre;
  document.getElementById("e-area").value = area;
  document.getElementById("e-nombre").focus();
};

window.borrar = async function (codigo, nombre) {
  if (!confirm(`¿Eliminar a "${nombre}" (${codigo}) de la base?`)) return;
  await fetch(`/api/empleados/${encodeURIComponent(codigo)}`, { method: "DELETE" });
  cargar();
};

document.getElementById("guardar").addEventListener("click", async () => {
  const body = {
    codigo: document.getElementById("e-codigo").value,
    nombre: document.getElementById("e-nombre").value,
    area: document.getElementById("e-area").value,
  };
  const msg = document.getElementById("msg");
  const d = await (await fetch("/api/empleados", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  if (d.ok) {
    msg.textContent = "Guardado ✓"; msg.style.color = "#4ade80";
    document.getElementById("e-codigo").value = "";
    document.getElementById("e-nombre").value = "";
    document.getElementById("e-area").value = "";
    cargar();
  } else {
    msg.textContent = d.mensaje || "Error"; msg.style.color = "#f87171";
  }
  setTimeout(() => { msg.textContent = ""; }, 2500);
});

cargar();
