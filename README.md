# Control de Asistencia por código de barras — demo

Estación de captura de asistencia que lee el **código de barras** del gafete y
registra entrada/salida en una **base de datos central** (SQLite). Evita lecturas
duplicadas, calcula horas y exporta a CSV. Reemplaza las listas de papel.

Proyecto **autocontenido**: sin Celery, Redis, ni dependencias externas.
La librería de cámara viene embebida (`static/vendor/`), así que funciona aunque
no haya internet en el lugar de la demo.

## Qué incluye

- **Estación de escaneo** (`/`): campo enfocado para **lector USB** (funciona como
  teclado) y botón de **cámara** (celular/tablet) con la misma lógica.
- **Administración** (`/admin`): pon nombre a los gafetes, ve el resumen del día y
  **exporta CSV**.
- Empleados de ejemplo ya cargados, incluido el gafete de muestra `2042568`.

## Correr en local (Windows, para probar ya)

```powershell
cd c:\brp-asistencia
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000
```

Abre <http://localhost:8000>. La cámara del navegador exige **HTTPS o localhost**;
en localhost funciona. Para el lector USB no hace falta nada: enfoca la página y
escanea.

> Personaliza el nombre mostrado:
> `powershell -c $env:EMPRESA='Nombre de la empresa'; uvicorn app:app --port 8000`

## Correr con Docker

```bash
EMPRESA="Nombre de la empresa" docker compose up -d --build
# queda en http://SERVIDOR:8080
```

La base de datos persiste en `./data/asistencia.db` (montado como volumen).

## Deploy en brp.swordalo.com

Igual que coatza: contenedor Docker detrás del reverse proxy del VPS.

1. En el VPS: `git clone <repo> /srv/brp` (o copia la carpeta).
2. `cd /srv/brp && EMPRESA="…" docker compose up -d --build`
   → el contenedor escucha en `127.0.0.1:8080`.
3. Apunta el DNS `brp.swordalo.com` al VPS (registro A).
4. Añade el subdominio al reverse proxy que ya usas. Ejemplos:

   **Caddy** (TLS automático):
   ```
   brp.swordalo.com {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   **Nginx** (con certbot para el certificado):
   ```nginx
   server {
       server_name brp.swordalo.com;
       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $remote_addr;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

> La cámara **requiere HTTPS** en un dominio real (los navegadores bloquean
> `getUserMedia` en HTTP). Con el certificado del reverse proxy queda cubierto.
> El lector USB funciona con o sin HTTPS.

## Notas para adaptarlo al cliente

- **Rebranding**: variable `EMPRESA`. Colores en `static/styles.css` (`--brand`).
- **Carga masiva de empleados**: hoy se dan de alta escaneando o desde `/admin`.
  Si el cliente tiene su padrón en Excel, se puede añadir un importador CSV.
- **Zona horaria**: `TZ` (por defecto `America/Mexico_City`).
- **Regla entrada/salida**: alterna automáticamente; la ventana anti doble-lectura
  es `DEBOUNCE_SEG` (8 s por defecto).

Esta demo cubre solo el **pase de lista / escáner**. El resto (seguimiento,
reportes avanzados, etc.) se construye encima según lo que pida el cliente.
