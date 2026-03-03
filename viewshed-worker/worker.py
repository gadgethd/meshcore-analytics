"""
MeshCore Analytics — Viewshed Worker
Consumes jobs from Redis, downloads SRTM1 tiles, computes a raycasting
viewshed, clips to the UK mainland, stores the result polygon in
node_coverage, then notifies the frontend.
"""

import gzip
import json
import logging
import math
import multiprocessing
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

import numpy as np
import psycopg2
from scipy.ndimage import minimum_filter as _min_filter
import redis
import requests
from osgeo import gdal
from shapely.geometry import mapping, Polygon as ShapelyPolygon

gdal.UseExceptions()

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

SRTM_DIR     = Path(os.environ.get('SRTM_DIR', '/data/srtm'))
REDIS_URL    = os.environ.get('REDIS_URL', 'redis://redis:6379')
DATABASE_URL = os.environ.get('DATABASE_URL')

JOB_QUEUE    = 'meshcore:viewshed_jobs'
LIVE_CHANNEL = 'meshcore:live'

ANTENNA_HEIGHT_M = 5        # observer height above ground (m) — fixed 5 m antenna
MAX_RADIUS_M     = 100_000  # absolute cap on viewshed radius (m)
SIMPLIFY_DEG     = 0.001    # Douglas-Peucker tolerance (~100 m)
N_RAYS           = 720      # number of radial rays cast from the observer
STEP_M           = 50.0     # ray step size in metres

# Radio horizon parameters
K_FACTOR  = 4 / 3        # effective Earth radius multiplier (standard troposphere)
R_EARTH_M = 6_371_000    # mean Earth radius (m)

# ── UK mainland polygon (loaded once at startup for ocean clipping) ───────────

def _load_uk_mainland():
    path = Path(__file__).parent / 'uk_mainland.json'
    if not path.exists():
        log.warning('uk_mainland.json not found — ocean clipping disabled')
        return None
    with open(path) as f:
        data = json.load(f)
    from shapely.geometry import shape as _shape
    poly = _shape(data)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if data['type'] == 'MultiPolygon':
        total_pts = sum(len(ring) for poly in data['coordinates'] for ring in poly)
        log.info(f'UK mainland MultiPolygon loaded ({len(data["coordinates"])} polygons, {total_pts} total points)')
    else:
        log.info(f'UK mainland polygon loaded ({len(data["coordinates"][0])} points)')
    return poly

UK_MAINLAND = _load_uk_mainland()

# ── SRTM tile download (AWS Terrain Tiles — public, no auth) ─────────────────

def tile_name(lat: int, lon: int) -> str:
    ns = 'N' if lat >= 0 else 'S'
    ew = 'E' if lon >= 0 else 'W'
    return f'{ns}{abs(lat):02d}{ew}{abs(lon):03d}'

def download_tile(lat: int, lon: int) -> Optional[Path]:
    name = tile_name(lat, lon)
    path = SRTM_DIR / f'{name}.hgt'
    if path.exists():
        return path

    url = (
        f'https://s3.amazonaws.com/elevation-tiles-prod/skadi/'
        f'{name[:3]}/{name}.hgt.gz'
    )
    log.info(f'Downloading {name} ...')
    try:
        resp = requests.get(url, timeout=60, stream=True)
        if resp.status_code == 404:
            log.debug(f'{name} not found (ocean / outside coverage)')
            return None
        resp.raise_for_status()
        data = gzip.decompress(resp.content)
        SRTM_DIR.mkdir(parents=True, exist_ok=True)
        # Atomic write: temp file → rename prevents partial-read races between workers
        tmp = path.with_suffix('.tmp')
        tmp.write_bytes(data)
        tmp.rename(path)
        log.info(f'Saved {name}.hgt ({len(data) // 1024} KB)')
        return path
    except Exception as exc:
        log.error(f'Failed to download {name}: {exc}')
        return None

def tiles_for_radius(lat: float, lon: float, radius_m: float) -> list[tuple[int, int]]:
    """All 1°×1° SRTM tiles that overlap a bounding box around (lat, lon)."""
    d_lat = radius_m / 111_320
    d_lon = radius_m / (111_320 * math.cos(math.radians(lat)))
    return [
        (lt, ln)
        for lt in range(math.floor(lat - d_lat), math.floor(lat + d_lat) + 1)
        for ln in range(math.floor(lon - d_lon), math.floor(lon + d_lon) + 1)
    ]

def radio_horizon_m(height_asl_m: float) -> float:
    """One-way radio horizon distance (m) for an antenna at height_asl_m above sea level.

    Uses the standard 4/3-Earth-radius model for tropospheric refraction.
    Formula: d = sqrt(2 * k * R * h)
    """
    h = max(1.0, height_asl_m)  # clamp: 1 m minimum to avoid zero
    return math.sqrt(2 * K_FACTOR * R_EARTH_M * h)


def sample_elevation(vrt_path: str, lat: float, lon: float) -> float:
    """Return terrain elevation (m ASL) at (lat, lon) sampled from a GDAL VRT."""
    ds = gdal.Open(vrt_path)
    if ds is None:
        return 0.0
    gt  = ds.GetGeoTransform()
    inv = gdal.InvGeoTransform(gt)
    if inv is None:
        ds = None
        return 0.0
    px, py = gdal.ApplyGeoTransform(inv, lon, lat)
    px = max(0, min(int(px), ds.RasterXSize - 1))
    py = max(0, min(int(py), ds.RasterYSize - 1))
    data = ds.GetRasterBand(1).ReadAsArray(px, py, 1, 1)
    ds   = None
    return max(0.0, float(data[0][0])) if data is not None else 0.0


# ── Viewshed calculation ──────────────────────────────────────────────────────

def calculate_viewshed(node_id: str, lat: float, lon: float) -> Optional[tuple[dict, float]]:
    with tempfile.TemporaryDirectory() as tmp:
        # 1. Download the observer's own tile and sample terrain elevation.
        #    This single tile is sufficient to determine node height; we need
        #    it before we know how far to reach for surrounding tiles.
        obs_tile = (math.floor(lat), math.floor(lon))
        obs_path = download_tile(*obs_tile)
        if not obs_path:
            log.error(f'No SRTM tile for observer at {node_id} ({lat:.4f}, {lon:.4f})')
            return None

        obs_vrt = f'{tmp}/observer.vrt'
        subprocess.run(
            ['gdalbuildvrt', obs_vrt, str(obs_path)],
            capture_output=True, text=True,
        )
        elevation_m = sample_elevation(obs_vrt, lat, lon)

        # 2. Radio-horizon radius: node ASL + 5 m fixed antenna height.
        effective_height_m = elevation_m + ANTENNA_HEIGHT_M
        radius_m = min(radio_horizon_m(effective_height_m), MAX_RADIUS_M)
        log.info(
            f'  {node_id[:12]}…: elevation={elevation_m:.0f} m ASL, '
            f'antenna={effective_height_m:.0f} m, horizon={radius_m / 1000:.1f} km'
        )

        # 3. Download all tiles covering the computed horizon radius
        needed = tiles_for_radius(lat, lon, radius_m)
        paths  = [p for t in needed if (p := download_tile(*t))]
        if not paths:
            log.error(f'No SRTM tiles for {node_id} ({lat:.4f}, {lon:.4f})')
            return None

        # 4. Merge tiles into a single VRT
        vrt = f'{tmp}/input.vrt'
        r   = subprocess.run(
            ['gdalbuildvrt', vrt] + [str(p) for p in paths],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            log.error(f'gdalbuildvrt failed: {r.stderr}')
            return None

        # 5. Read entire elevation raster into memory once.
        #    NODATA ocean pixels (INT16 -32768) are clamped to 0 — treated as sea level.
        ds   = gdal.Open(vrt)
        gt   = ds.GetGeoTransform()   # (x_origin, px_lon, 0, y_origin, 0, px_lat)
        elev = np.clip(
            ds.GetRasterBand(1).ReadAsArray().astype(np.float32),
            0, None,
        )
        n_rows, n_cols = elev.shape
        ds = None

        # 5b. Approximate DTM from SRTM DSM via spatial minimum filter.
        #     SRTM is a Digital Surface Model — building heights corrupt urban
        #     areas causing raycasting to terminate within metres of the observer.
        #     A 9-pixel (~270 m for SRTM1 at 30 m/px) minimum filter strips
        #     building-height spikes while preserving genuine terrain features
        #     (hills, ridges) whose footprints are wider than ~270 m.
        elev = _min_filter(elev, size=9)

        # 5c. Re-sample observer elevation from the DTM-approximated raster.
        #     This corrects the radio-horizon radius when SRTM reads building tops.
        obs_px = int(np.clip((lon - gt[0]) / gt[1], 0, n_cols - 1))
        obs_py = int(np.clip((lat - gt[3]) / gt[5], 0, n_rows - 1))
        dtm_elev = float(elev[obs_py, obs_px])
        # Guard against coastal bleed-in: min filter near shoreline may return 0
        # (ocean NODATA) even for land pixels.  Fall back to raw SRTM in that case.
        if dtm_elev > 0.0 or elevation_m <= 0.0:
            elevation_m = dtm_elev
        effective_height_m = elevation_m + ANTENNA_HEIGHT_M
        radius_m = min(radio_horizon_m(effective_height_m), MAX_RADIUS_M)
        log.info(
            f'  {node_id[:12]}… DTM elevation={elevation_m:.0f} m ASL, '
            f'horizon={radius_m / 1000:.1f} km'
        )

        # 6. Vectorised raycasting viewshed.
        #
        # For each of N_RAYS directions, walk outward in STEP_M increments tracking
        # the maximum "elevation angle" seen so far (corrected for Earth curvature).
        # When a step's angle falls below the running maximum, the terrain at that
        # step is in the shadow of an earlier ridge → the ray terminates.
        # The stop-point of each ray becomes a vertex of the coverage boundary.
        #
        # Elevation angle formula:
        #   angle(d) = (terrain_h - observer_h - d² / (2·k·R)) / d
        # where the d²/(2kR) term accounts for Earth's curvature under the ray.
        # A ray is blocked when angle(d) < running_max — no wrap-around artefacts.
        observer_h = elevation_m + ANTENNA_HEIGHT_M
        dpmlat = 1.0 / 111_320.0                                       # deg/m northward
        dpmlon = 1.0 / (111_320.0 * math.cos(math.radians(lat)))       # deg/m eastward
        R_eff_2 = 2.0 * K_FACTOR * R_EARTH_M                          # 2kR curvature denom

        n_steps = max(1, int(radius_m / STEP_M))
        ds_arr  = np.linspace(STEP_M, radius_m, n_steps)    # (M,) distances in metres
        thetas  = np.linspace(0.0, 2.0 * math.pi, N_RAYS, endpoint=False)   # (N,) angles

        # Ray sample coordinates: (N, M)
        sin_t   = np.sin(thetas)[:, None]    # (N, 1)
        cos_t   = np.cos(thetas)[:, None]    # (N, 1)
        pt_lats = lat + sin_t * ds_arr[None, :] * dpmlat   # (N, M)
        pt_lons = lon + cos_t * ds_arr[None, :] * dpmlon   # (N, M)

        # Pixel indices — clamped to raster bounds (N, M)
        # gt[0]=x_origin (lon), gt[1]=px_width (deg/px), gt[3]=y_origin (lat), gt[5]=px_height (<0)
        pxs = np.clip(((pt_lons - gt[0]) / gt[1]).astype(np.int32), 0, n_cols - 1)
        pys = np.clip(((pt_lats - gt[3]) / gt[5]).astype(np.int32), 0, n_rows - 1)

        # Terrain heights at each ray step: (N, M)
        hs = elev[pys, pxs]

        # Elevation angles with Earth-curvature correction: (N, M)
        angles = (hs - observer_h - ds_arr[None, :] ** 2 / R_eff_2) / ds_arr[None, :]

        # Running max along each ray — only terrain AT OR ABOVE the observer
        # height can establish a blocking horizon.  Terrain below the observer
        # always lets the ray "see past" it; coverage is only cut off when
        # something taller than the node rises into the line of sight.
        blocking    = np.where(hs >= observer_h, angles, -np.inf)   # (N, M)
        running_max = np.maximum.accumulate(blocking, axis=1)        # (N, M)

        # "Previous" running max — shift one step so we compare current angle with
        # the max established BEFORE this step.  First column = -inf (never blocked).
        prev_max   = np.concatenate([np.full((N_RAYS, 1), -np.inf), running_max[:, :-1]], axis=1)
        in_shadow  = angles < prev_max   # (N, M): True where ray is terrain-blocked

        # Index of first shadow step per ray; n_steps if never shadowed.
        has_shadow  = in_shadow.any(axis=1)                                          # (N,)
        first_shad  = np.where(has_shadow, in_shadow.argmax(axis=1), n_steps)       # (N,)
        last_js     = np.clip(first_shad - 1, 0, n_steps - 1)                       # (N,)
        last_ds     = ds_arr[last_js]                                                # (N,)

        # Build boundary ring in (lon, lat) GeoJSON order.
        lons_b   = lon + np.cos(thetas) * last_ds * dpmlon   # (N,)
        lats_b   = lat + np.sin(thetas) * last_ds * dpmlat   # (N,)
        boundary = list(zip(lons_b.tolist(), lats_b.tolist()))
        boundary.append(boundary[0])   # close ring

        poly = ShapelyPolygon(boundary)
        if not poly.is_valid:
            poly = poly.buffer(0)

        # 7. Clip to UK mainland — removes coverage that extends into the sea.
        if UK_MAINLAND is not None:
            poly = poly.intersection(UK_MAINLAND)
            if poly.is_empty:
                log.warning(f'{node_id}: viewshed entirely at sea — skipping')
                return None

        # 8. Simplify (~100 m tolerance) to reduce stored polygon size.
        result = poly.simplify(SIMPLIFY_DEG, preserve_topology=True)

        if result.is_empty or result.geom_type not in ('Polygon', 'MultiPolygon'):
            log.warning(f'{node_id}: degenerate geometry after clipping — skipping')
            return None

        return mapping(result), radius_m

# ── DB helpers ────────────────────────────────────────────────────────────────

def already_calculated(db, node_id: str) -> bool:
    with db.cursor() as cur:
        cur.execute('SELECT 1 FROM node_coverage WHERE node_id = %s', (node_id,))
        return cur.fetchone() is not None

def store_coverage(db, node_id: str, geom: dict, radius_m: float):
    with db.cursor() as cur:
        cur.execute(
            '''INSERT INTO node_coverage (node_id, geom, antenna_height_m, radius_m)
               VALUES (%s, %s::jsonb, %s, %s)
               ON CONFLICT (node_id) DO UPDATE
                 SET geom = EXCLUDED.geom,
                     antenna_height_m = EXCLUDED.antenna_height_m,
                     radius_m = EXCLUDED.radius_m,
                     calculated_at = NOW()''',
            (node_id, json.dumps(geom), ANTENNA_HEIGHT_M, radius_m),
        )
    db.commit()

def enqueue_uncovered(db, r_client):
    """On startup, queue all nodes that have a position but no coverage yet."""
    # Remove any coverage that was previously computed for hidden or non-repeater nodes.
    with db.cursor() as cur:
        cur.execute("""
            DELETE FROM node_coverage WHERE node_id IN (
                SELECT node_id FROM nodes
                WHERE name LIKE '%🚫%' OR (role IS NOT NULL AND role != 2)
            )
        """)
    db.commit()

    with db.cursor() as cur:
        cur.execute('''
            SELECT n.node_id, n.lat, n.lon
            FROM nodes n
            LEFT JOIN node_coverage nc ON n.node_id = nc.node_id
            WHERE n.lat IS NOT NULL AND n.lon IS NOT NULL
              AND nc.node_id IS NULL
              AND (n.name IS NULL OR n.name NOT LIKE %s)
              AND (n.role IS NULL OR n.role = 2)
        ''', ('%🚫%',))
        rows = cur.fetchall()
    if rows:
        log.info(f'Queuing {len(rows)} existing node(s) for viewshed calculation')
        for node_id, lat, lon in rows:
            r_client.lpush(JOB_QUEUE, json.dumps({'node_id': node_id, 'lat': lat, 'lon': lon}))

# ── Job processor ─────────────────────────────────────────────────────────────

def process_job(db, r_client, job: dict):
    node_id = job['node_id']
    lat     = float(job['lat'])
    lon     = float(job['lon'])

    # Skip hidden (🚫) or non-repeater nodes regardless of how the job arrived
    with db.cursor() as cur:
        cur.execute('SELECT name, role FROM nodes WHERE node_id = %s', (node_id,))
        row = cur.fetchone()
    if row:
        name, role = row
        if name and '🚫' in name:
            log.info(f'Skipping hidden node {node_id[:12]}…')
            return
        if role is not None and role != 2:
            log.info(f'Skipping non-repeater {node_id[:12]}… (role={role})')
            return

    if already_calculated(db, node_id):
        log.info(f'Coverage already exists for {node_id[:12]}…, skipping')
        return

    log.info(f'Viewshed: {node_id[:12]}… at ({lat:.4f}, {lon:.4f})')
    t0     = time.time()
    result = calculate_viewshed(node_id, lat, lon)
    if result is None:
        return

    geom, radius_m = result
    store_coverage(db, node_id, geom, radius_m)
    log.info(f'Done in {time.time() - t0:.1f}s — notifying frontend')

    r_client.publish(LIVE_CHANNEL, json.dumps({
        'type': 'coverage_update',
        'data': {'node_id': node_id, 'geom': geom},
        'ts':   int(time.time() * 1000),
    }))

# ── Main loop ─────────────────────────────────────────────────────────────────

def wait_for_db() -> psycopg2.extensions.connection:
    for attempt in range(30):
        try:
            conn = psycopg2.connect(DATABASE_URL)
            # autocommit=True prevents SELECT queries from holding open transactions
            # that would block schema DDL (CREATE EXTENSION etc.) on app restart.
            conn.autocommit = True
            conn.cursor().execute('SELECT 1')
            return conn
        except Exception:
            log.info(f'Waiting for DB… (attempt {attempt + 1}/30)')
            time.sleep(3)
    raise RuntimeError('DB never became ready')

def worker_loop():
    """Single worker process: owns its own DB and Redis connections."""
    name     = multiprocessing.current_process().name
    db       = wait_for_db()
    r_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    log.info(f'{name} ready')

    while True:
        try:
            item = r_client.brpop(JOB_QUEUE, timeout=60)
            if item is None:
                continue
            _, raw = item
            process_job(db, r_client, json.loads(raw))
        except psycopg2.OperationalError:
            log.warning(f'{name}: DB connection lost — reconnecting')
            db = wait_for_db()
        except Exception as exc:
            log.error(f'{name}: job error: {exc}', exc_info=True)

def main():
    log.info('Viewshed worker starting')
    SRTM_DIR.mkdir(parents=True, exist_ok=True)

    # Connect once just to enqueue any nodes that lack coverage, then hand off
    # to the worker processes (each gets its own connection).
    db = wait_for_db()
    log.info('Connected to DB')
    r = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    r.ping()
    log.info('Connected to Redis')
    enqueue_uncovered(db, r)
    db.close()

    num_workers = int(os.environ.get('NUM_WORKERS', '2'))
    log.info(f'Launching {num_workers} worker process(es)')

    if num_workers <= 1:
        worker_loop()
        return

    procs = [
        multiprocessing.Process(target=worker_loop, name=f'Worker-{i + 1}', daemon=True)
        for i in range(num_workers)
    ]
    for p in procs:
        p.start()
    for p in procs:
        p.join()

if __name__ == '__main__':
    main()
