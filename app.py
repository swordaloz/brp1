"""
Control de Asistencia por código de barras — demo autocontenida.

- Backend: FastAPI + SQLite (stdlib). Sin Celery/Redis/servicios externos.
- Escaneo: el mismo endpoint sirve para lector USB (teclado) y cámara (JS).
- Lógica: alterna entrada/salida, evita doble lectura y calcula horas.

Correr local:  uvicorn app:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import csv
import io
import os
import sqlite3
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(os.environ.get("TZ", "America/Mexico_City"))
except Exception:  # pragma: no cover - fallback si no hay tzdata
    TZ = None

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", BASE_DIR / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "asistencia.db"

EMPRESA = os.environ.get("EMPRESA", "Control de Asistencia")
# Ventana anti doble-lectura (un lector suele disparar 2 veces por escaneo).
DEBOUNCE_SEG = int(os.environ.get("DEBOUNCE_SEG", "8"))

app = FastAPI(title="Asistencia — demo")


# --------------------------------------------------------------------------- #
# Base de datos
# --------------------------------------------------------------------------- #
def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL;")
    return c


def init_db() -> None:
    with closing(conn()) as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS empleados (
                codigo   TEXT PRIMARY KEY,
                nombre   TEXT NOT NULL,
                area     TEXT DEFAULT '',
                creado   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS registros (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                codigo   TEXT NOT NULL,
                nombre   TEXT NOT NULL,
                tipo     TEXT NOT NULL,          -- 'entrada' | 'salida'
                ts       TEXT NOT NULL,          -- ISO local
                fecha    TEXT NOT NULL,          -- YYYY-MM-DD
                horas    REAL                    -- llenado en la 'salida'
            );
            CREATE INDEX IF NOT EXISTS idx_reg_fecha  ON registros(fecha);
            CREATE INDEX IF NOT EXISTS idx_reg_codigo ON registros(codigo, fecha);
            """
        )
        # Empleados de ejemplo para que la demo funcione de inmediato.
        # Incluye el gafete real de la foto (2042568) para escanearlo en vivo.
        seed = [
            ("2042568", "Empleado Demo (gafete de muestra)", "Producción"),
            ("1001", "Ana Martínez", "Recursos Humanos"),
            ("1002", "Carlos López", "Producción"),
            ("1003", "María Hernández", "Calidad"),
            ("1004", "Jorge Ramírez", "Mantenimiento"),
        ]
        now = ahora().isoformat(timespec="seconds")
        for cod, nom, area in seed:
            c.execute(
                "INSERT OR IGNORE INTO empleados(codigo, nombre, area, creado) "
                "VALUES (?,?,?,?)",
                (cod, nom, area, now),
            )
        c.commit()


def ahora() -> datetime:
    return datetime.now(TZ) if TZ else datetime.now()


# --------------------------------------------------------------------------- #
# Esquemas
# --------------------------------------------------------------------------- #
class ScanIn(BaseModel):
    codigo: str


class EmpleadoIn(BaseModel):
    codigo: str
    nombre: str
    area: str = ""


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.on_event("startup")
def _startup() -> None:
    init_db()


@app.get("/api/config")
def config() -> dict:
    return {"empresa": EMPRESA}


@app.post("/api/scan")
def scan(body: ScanIn) -> JSONResponse:
    codigo = (body.codigo or "").strip()
    if not codigo:
        return JSONResponse({"ok": False, "mensaje": "Código vacío"}, status_code=400)

    now = ahora()
    fecha = now.strftime("%Y-%m-%d")

    with closing(conn()) as c:
        emp = c.execute(
            "SELECT * FROM empleados WHERE codigo = ?", (codigo,)
        ).fetchone()
        if emp is None:
            # Alta automática: cualquier gafete escaneado "simplemente funciona";
            # luego se renombra desde el panel admin.
            nombre = f"Sin nombre ({codigo})"
            c.execute(
                "INSERT INTO empleados(codigo, nombre, area, creado) VALUES (?,?,?,?)",
                (codigo, nombre, "", now.isoformat(timespec="seconds")),
            )
            c.commit()
        else:
            nombre = emp["nombre"]

        ultimo = c.execute(
            "SELECT * FROM registros WHERE codigo = ? AND fecha = ? "
            "ORDER BY id DESC LIMIT 1",
            (codigo, fecha),
        ).fetchone()

        # Anti doble-lectura.
        if ultimo is not None:
            delta = (now - datetime.fromisoformat(ultimo["ts"])).total_seconds()
            if delta < DEBOUNCE_SEG:
                return JSONResponse(
                    {
                        "ok": False,
                        "duplicado": True,
                        "nombre": nombre,
                        "mensaje": "Lectura repetida ignorada",
                    }
                )

        tipo = "entrada" if (ultimo is None or ultimo["tipo"] == "salida") else "salida"

        horas = None
        if tipo == "salida":
            # Emparejar con la última 'entrada' del día para calcular la sesión.
            entrada = c.execute(
                "SELECT * FROM registros WHERE codigo = ? AND fecha = ? "
                "AND tipo = 'entrada' ORDER BY id DESC LIMIT 1",
                (codigo, fecha),
            ).fetchone()
            if entrada is not None:
                dt = (now - datetime.fromisoformat(entrada["ts"])).total_seconds()
                horas = round(dt / 3600.0, 2)

        c.execute(
            "INSERT INTO registros(codigo, nombre, tipo, ts, fecha, horas) "
            "VALUES (?,?,?,?,?,?)",
            (codigo, nombre, tipo, now.isoformat(timespec="seconds"), fecha, horas),
        )
        c.commit()

        total = c.execute(
            "SELECT COALESCE(SUM(horas), 0) AS t FROM registros "
            "WHERE codigo = ? AND fecha = ?",
            (codigo, fecha),
        ).fetchone()["t"]

    return JSONResponse(
        {
            "ok": True,
            "codigo": codigo,
            "nombre": nombre,
            "tipo": tipo,
            "hora": now.strftime("%H:%M:%S"),
            "horas_sesion": horas,
            "horas_dia": round(total or 0, 2),
            "mensaje": f"{'Entrada' if tipo == 'entrada' else 'Salida'} registrada",
        }
    )


@app.get("/api/registros/hoy")
def registros_hoy() -> dict:
    fecha = ahora().strftime("%Y-%m-%d")
    with closing(conn()) as c:
        rows = c.execute(
            "SELECT * FROM registros WHERE fecha = ? ORDER BY id DESC LIMIT 200",
            (fecha,),
        ).fetchall()
        presentes = c.execute(
            """
            SELECT COUNT(*) AS n FROM (
              SELECT codigo, MAX(id) AS mid FROM registros
              WHERE fecha = ? GROUP BY codigo
            ) u JOIN registros r ON r.id = u.mid
            WHERE r.tipo = 'entrada'
            """,
            (fecha,),
        ).fetchone()["n"]
        tothoras = c.execute(
            "SELECT COALESCE(SUM(horas),0) AS t FROM registros WHERE fecha = ?",
            (fecha,),
        ).fetchone()["t"]
    return {
        "fecha": fecha,
        "presentes": presentes,
        "total_registros": len(rows),
        "horas_totales": round(tothoras or 0, 2),
        "registros": [dict(r) for r in rows],
    }


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
            (codigo, body.nombre.strip(), body.area.strip(),
             ahora().isoformat(timespec="seconds")),
        )
        c.commit()
    return {"ok": True}


@app.get("/api/export.csv")
def export_csv(fecha: str | None = None) -> Response:
    with closing(conn()) as c:
        if fecha:
            rows = c.execute(
                "SELECT * FROM registros WHERE fecha = ? ORDER BY id", (fecha,)
            ).fetchall()
        else:
            rows = c.execute("SELECT * FROM registros ORDER BY id").fetchall()

    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "codigo", "nombre", "tipo", "fecha", "hora", "horas_sesion"])
    for r in rows:
        ts = datetime.fromisoformat(r["ts"])
        w.writerow([
            r["id"], r["codigo"], r["nombre"], r["tipo"],
            r["fecha"], ts.strftime("%H:%M:%S"),
            "" if r["horas"] is None else r["horas"],
        ])
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="asistencia_{fecha or "todo"}.csv"'},
    )


# --------------------------------------------------------------------------- #
# Páginas
# --------------------------------------------------------------------------- #
@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "index.html")


@app.get("/admin")
def admin() -> FileResponse:
    return FileResponse(BASE_DIR / "static" / "admin.html")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
