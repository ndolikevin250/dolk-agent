// ─── STRUCTURED LOGGER ──────────────────────────────────
// Lightweight logger with levels, timestamps, and request ID support.
// No external dependencies — outputs JSON to stdout/stderr for production,
// human-readable format for development.

const isProduction = process.env.NODE_ENV === 'production';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LEVELS[process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug')] || 0;

function log(level, message, meta = {}) {
  if (LEVELS[level] < minLevel) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta
  };

  // Remove undefined values
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key];
  }

  const output = isProduction
    ? JSON.stringify(entry)
    : `${entry.timestamp} [${level.toUpperCase()}] ${message}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`;

  if (level === 'error') {
    process.stderr.write(output + '\n');
  } else {
    process.stdout.write(output + '\n');
  }
}

module.exports = {
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta)
};
