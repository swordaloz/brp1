"""
Control de Asistencia por EVENTOS (pase de lista) — demo autocontenida.

- Backend: FastAPI + SQLite (stdlib). Sin Celery/Redis/servicios externos.
- Empleados: base de personas (alta, baja, exportar).
- Eventos: nombre, tipo/curso, detalles, fecha e invitados seleccionados.
- Estación: se elige el evento activo y se escanea (pistola USB o cámara).
  En vivo: quiénes llegaron, cuántas veces, y quiénes faltan de los invitados.

Correr local:  uvicorn app:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import csv
import io
import os
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(os.environ.get("TZ", "America/Mexico_City"))
except Exception:  # pragma: no cover
    TZ = None

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "asistencia.db"

EMPRESA = os.environ.get("EMPRESA", "Lear Corporation")
# Ventana anti doble-lectura (un lector suele disparar 2 veces por escaneo).
DEBOUNCE_SEG = int(os.environ.get("DEBOUNCE_SEG", "8"))

app = FastAPI(title="Asistencia por eventos")


# --------------------------------------------------------------------------- #
# Base de datos
# --------------------------------------------------------------------------- #
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL;")
    c.execute("PRAGMA foreign_keys=ON;")
    return c


def ahora() -> datetime:
    return datetime.now(TZ) if TZ else datetime.now()


def iso() -> str:
    return ahora().isoformat(timespec="seconds")


def init_db() -> None:
    with closing(conn()) as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS empleados (
                codigo TEXT PRIMARY KEY,
                nombre TEXT NOT NULL,
                area   TEXT DEFAULT '',
                creado TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS eventos (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                nombre   TEXT NOT NULL,
                tipo     TEXT DEFAULT '',      -- curso, junta, capacitación...
                detalles TEXT DEFAULT '',
                fecha    TEXT DEFAULT '',       -- YYYY-MM-DD (opcional)
                creado   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS evento_invitados (
                evento_id INTEGER NOT NULL,
                codigo    TEXT NOT NULL,
                PRIMARY KEY (evento_id, codigo)
            );
            CREATE TABLE IF NOT EXISTS asistencias (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                evento_id INTEGER NOT NULL,
                codigo    TEXT NOT NULL,
                nombre    TEXT NOT NULL,
                ts        TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_asist_ev ON asistencias(evento_id, codigo);
            CREATE INDEX IF NOT EXISTS idx_inv_ev   ON evento_invitados(evento_id);
            """
        )
        # Empleados de ejemplo (sólo si la tabla está vacía en un install nuevo).
        seed = [
            ("2042568", "Empleado Demo (gafete de muestra)", "Producción"),
            ("1001", "Ana Martínez", "Recursos Humanos"),
            ("1002", "Carlos López", "Producción"),
            ("1003", "María Hernández", "Calidad"),
            ("1004", "Jorge Ramírez", "Mantenimiento"),
        ]
        now = iso()
        for cod, nom, area in seed:
            c.execute(
                "INSERT OR IGNORE INTO empleados(codigo,nombre,area,creado) VALUES (?,?,?,?)",
                (cod, nom, area, now),
            )
        c.commit()


# --------------------------------------------------------------------------- #
# Esquemas
# --------------------------------------------------------------------------- #
class ScanIn(BaseModel):
    codigo: str
    evento_id: int


class EmpleadoIn(BaseModel):
    codigo: str
    nombre: str
    area: str = ""


class EventoIn(BaseModel):
    nombre: str
    tipo: str = ""
    detalles: str = ""
    fecha: str = ""
    invitados: list[str] = []


class InvitadosIn(BaseModel):
    codigos: list[str] = []


# --------------------------------------------------------------------------- #
# Estado de un evento (roster + resumen)
# --------------------------------------------------------------------------- #
def evento_estado(c: sqlite3.Connection, evento_id: int):
    ev = c.execute("SELECT * FROM eventos WHERE id=?", (evento_id,)).fetchone()
    if ev is None:
        return None
    roster = c.execute(
        """
        SELECT ei.codigo, e.nombre, e.area,
               COUNT(a.id) AS veces, MAX(a.ts) AS ultima
        FROM evento_invitados ei
        JOIN empleados e ON e.codigo = ei.codigo
        LEFT JOIN asistencias a
               ON a.evento_id = ei.evento_id AND a.codigo = ei.codigo
        WHERE ei.evento_id = ?
        GROUP BY ei.codigo, e.nombre, e.area
        ORDER BY (COUNT(a.id) > 0) DESC, e.nombre COLLATE NOCASE
        """,
        (evento_id,),
    ).fetchall()
    walkins = c.execute(
        """
        SELECT a.codigo, a.nombre, COUNT(*) AS veces, MAX(a.ts) AS ultima
        FROM asistencias a
        WHERE a.evento_id = ?
          AND a.codigo NOT IN (SELECT codigo FROM evento_invitados WHERE evento_id = ?)
        GROUP BY a.codigo, a.nombre
        ORDER BY a.nombre COLLATE NOCASE
        """,
        (evento_id, evento_id),
    ).fetchall()
    invitados = len(roster)
    presentes = sum(1 for r in roster if r["veces"] > 0)
    total_scans = c.execute(
        "SELECT COUNT(*) n FROM asistencias WHERE evento_id=?", (evento_id,)
    ).fetchone()["n"]
    return {
        "evento": dict(ev),
        "resumen": {
            "invitados": invitados,
            "presentes": presentes,
            "ausentes": invitados - presentes,
            "walkins": len(walkins),
            "total_scans": total_scans,
        },
        "invitados": [{**dict(r), "presente": r["veces"] > 0} for r in roster],
        "walkins": [dict(r) for r in walkins],
    }


# --------------------------------------------------------------------------- #
# API — configuración
# --------------------------------------------------------------------------- #
@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/config")
def config() -> dict:
    return {"empresa": EMPRESA}


# --------------------------------------------------------------------------- #
# API — empleados
# --------------------------------------------------------------------------- #
@app.get("/api/empleados")
def empleados() -> dict:
    with closing(conn()) as c:
        rows = c.execute(
            "SELECT * FROM empleados ORDER BY nombre COLLATE NOCASE"
        ).fetchall()
    return {"empleados": [dict(r) for r in rows]}


@app.post("/api/empleados")
def upsert_empleado(body: EmpleadoIn) -> dict:
    codigo = body.codigo.strip()
    if not codigo or not body.nombre.strip():
        return {"ok": False, "mensaje": "Código y nombre son obligatorios"}
    with closing(conn()) as c:
        c.execute(
            """
            INSERT INTO empleados(codigo, nombre, area, creado)
            VALUES (?,?,?,?)
            ON CONFLICT(codigo) DO UPDATE SET nombre=excluded.nombre, area=excluded.area
            """,
            (codigo, body.nombre.strip(), body.area.strip(), iso()),
        )
        c.commit()
    return {"ok": True}


@app.delete("/api/empleados/{codigo}")
def borrar_empleado(codigo: str) -> dict:
    with closing(conn()) as c:
        c.execute("DELETE FROM empleados WHERE codigo=?", (codigo,))
        # Sale de los rosters; el histórico de asistencias se conserva.
        c.execute("DELETE FROM evento_invitados WHERE codigo=?", (codigo,))
        c.commit()
    return {"ok": True}


@app.get("/api/empleados/export.csv")
def export_empleados() -> Response:
    with closing(conn()) as c:
        rows = c.execute(
            "SELECT * FROM empleados ORDER BY nombre COLLATE NOCASE"
        ).fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["codigo", "nombre", "area", "alta"])
    for r in rows:
        w.writerow([r["codigo"], r["nombre"], r["area"], r["creado"]])
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="empleados.csv"'},
    )


# --------------------------------------------------------------------------- #
# API — eventos
# --------------------------------------------------------------------------- #
@app.get("/api/eventos")
def listar_eventos() -> dict:
    with closing(conn()) as c:
        rows = c.execute(
            """
            SELECT ev.*,
              (SELECT COUNT(*) FROM evento_invitados WHERE evento_id=ev.id) AS invitados,
              (SELECT COUNT(DISTINCT codigo) FROM asistencias WHERE evento_id=ev.id) AS asistieron
            FROM eventos ev
            ORDER BY ev.id DESC
            """
        ).fetchall()
    return {"eventos": [dict(r) for r in rows]}


@app.post("/api/eventos")
def crear_evento(body: EventoIn) -> dict:
    if not body.nombre.strip():
        return {"ok": False, "mensaje": "El nombre del evento es obligatorio"}
    with closing(conn()) as c:
        cur = c.execute(
            "INSERT INTO eventos(nombre,tipo,detalles,fecha,creado) VALUES (?,?,?,?,?)",
            (body.nombre.strip(), body.tipo.strip(), body.detalles.strip(),
             body.fecha.strip(), iso()),
        )
        ev_id = cur.lastrowid
        for cod in body.invitados:
            cod = (cod or "").strip()
            if cod:
                c.execute(
                    "INSERT OR IGNORE INTO evento_invitados(evento_id,codigo) VALUES (?,?)",
                    (ev_id, cod),
                )
        c.commit()
    return {"ok": True, "id": ev_id}


@app.get("/api/eventos/{evento_id}")
def detalle_evento(evento_id: int) -> JSONResponse:
    with closing(conn()) as c:
        estado = evento_estado(c, evento_id)
    if estado is None:
        return JSONResponse({"ok": False, "mensaje": "Evento no encontrado"}, status_code=404)
    return JSONResponse(estado)


@app.get("/api/eventos/{evento_id}/estado")
def estado_evento(evento_id: int) -> JSONResponse:
    return detalle_evento(evento_id)


@app.post("/api/eventos/{evento_id}/invitados")
def agregar_invitados(evento_id: int, body: InvitadosIn) -> dict:
    with closing(conn()) as c:
        if c.execute("SELECT 1 FROM eventos WHERE id=?", (evento_id,)).fetchone() is None:
            return {"ok": False, "mensaje": "Evento no encontrado"}
        for cod in body.codigos:
            cod = (cod or "").strip()
            if cod:
                c.execute(
                    "INSERT OR IGNORE INTO evento_invitados(evento_id,codigo) VALUES (?,?)",
                    (evento_id, cod),
                )
        c.commit()
    return {"ok": True}


@app.delete("/api/eventos/{evento_id}/invitados/{codigo}")
def quitar_invitado(evento_id: int, codigo: str) -> dict:
    with closing(conn()) as c:
        c.execute(
            "DELETE FROM evento_invitados WHERE evento_id=? AND codigo=?",
            (evento_id, codigo),
        )
        c.commit()
    return {"ok": True}


@app.delete("/api/eventos/{evento_id}")
def borrar_evento(evento_id: int) -> dict:
    with closing(conn()) as c:
        c.execute("DELETE FROM asistencias WHERE evento_id=?", (evento_id,))
        c.execute("DELETE FROM evento_invitados WHERE evento_id=?", (evento_id,))
        c.execute("DELETE FROM eventos WHERE id=?", (evento_id,))
        c.commit()
    return {"ok": True}


@app.get("/api/eventos/{evento_id}/export.csv")
def export_evento(evento_id: int) -> Response:
    with closing(conn()) as c:
        estado = evento_estado(c, evento_id)
    if estado is None:
        return Response("Evento no encontrado", status_code=404)
    ev = estado["evento"]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([f"Evento: {ev['nombre']}", ev.get("tipo", ""), ev.get("fecha", "")])
    w.writerow([])
    w.writerow(["codigo", "nombre", "area", "estatus", "veces", "ultima_asistencia"])
    for r in estado["invitados"]:
        w.writerow([
            r["codigo"], r["nombre"], r.get("area", ""),
            "PRESENTE" if r["presente"] else "AUSENTE",
            r["veces"], r["ultima"] or "",
        ])
    for r in estado["walkins"]:
        w.writerow([r["codigo"], r["nombre"], "", "NO INVITADO (asistió)", r["veces"], r["ultima"] or ""])
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="evento_{evento_id}.csv"'},
    )


# --------------------------------------------------------------------------- #
# API — escaneo
# --------------------------------------------------------------------------- #
@app.post("/api/scan")
def scan(body: ScanIn) -> JSONResponse:
    codigo = (body.codigo or "").strip()
    if not codigo:
        return JSONResponse({"ok": False, "mensaje": "Código vacío"}, status_code=400)

    now = ahora()
    with closing(conn()) as c:
        ev = c.execute("SELECT * FROM eventos WHERE id=?", (body.evento_id,)).fetchone()
        if ev is None:
            return JSONResponse({"ok": False, "mensaje": "Evento no encontrado"}, status_code=404)

        emp = c.execute("SELECT * FROM empleados WHERE codigo=?", (codigo,)).fetchone()
        if emp is None:
            nombre = f"Sin nombre ({codigo})"
            c.execute(
                "INSERT INTO empleados(codigo,nombre,area,creado) VALUES (?,?,?,?)",
                (codigo, nombre, "", iso()),
            )
            c.commit()
        else:
            nombre = emp["nombre"]

        # Anti doble-lectura dentro del mismo evento.
        ult = c.execute(
            "SELECT ts FROM asistencias WHERE evento_id=? AND codigo=? ORDER BY id DESC LIMIT 1",
            (body.evento_id, codigo),
        ).fetchone()
        if ult is not None:
            delta = (now - datetime.fromisoformat(ult["ts"])).total_seconds()
            if delta < DEBOUNCE_SEG:
                veces = c.execute(
                    "SELECT COUNT(*) n FROM asistencias WHERE evento_id=? AND codigo=?",
                    (body.evento_id, codigo),
                ).fetchone()["n"]
                return JSONResponse({
                    "ok": False, "duplicado": True, "nombre": nombre,
                    "veces": veces, "mensaje": "Lectura repetida ignorada",
                })

        c.execute(
            "INSERT INTO asistencias(evento_id,codigo,nombre,ts) VALUES (?,?,?,?)",
            (body.evento_id, codigo, nombre, now.isoformat(timespec="seconds")),
        )
        c.commit()
        veces = c.execute(
            "SELECT COUNT(*) n FROM asistencias WHERE evento_id=? AND codigo=?",
            (body.evento_id, codigo),
        ).fetchone()["n"]
        invitado = c.execute(
            "SELECT 1 FROM evento_invitados WHERE evento_id=? AND codigo=?",
            (body.evento_id, codigo),
        ).fetchone() is not None

    return JSONResponse({
        "ok": True,
        "codigo": codigo,
        "nombre": nombre,
        "hora": now.strftime("%H:%M:%S"),
        "veces": veces,
        "primera": veces == 1,
        "invitado": invitado,
        "mensaje": "Asistencia registrada",
    })


# --------------------------------------------------------------------------- #
# Páginas
# --------------------------------------------------------------------------- #
@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/eventos")
def pagina_eventos() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "eventos.html")


@app.get("/empleados")
def pagina_empleados() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "empleados.html")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
