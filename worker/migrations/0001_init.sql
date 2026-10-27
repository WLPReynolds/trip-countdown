-- One record per trip; the trip itself is stored as JSON.
CREATE TABLE IF NOT EXISTS trips (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Daily copies of the forecast for each trip day, to chart how it changes.
CREATE TABLE IF NOT EXISTS forecast_snapshots (
  trip_id     TEXT NOT NULL,
  taken_on    TEXT NOT NULL,
  target_date TEXT NOT NULL,
  tmax        REAL,
  tmin        REAL,
  precip      REAL,
  rain_chance REAL,
  wind        REAL,
  uv          REAL,
  code        INTEGER,
  PRIMARY KEY (trip_id, taken_on, target_date)
);
