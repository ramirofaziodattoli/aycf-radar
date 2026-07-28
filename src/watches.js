// Qué vuelos te interesan. Todo opcional menos `from` y `to`.
//
// El horizonte lo fija la API: solo se puede consultar D+1. Los filtros de fecha
// no amplían nada, sirven para SILENCIAR — "esta ruta avisame solo los viernes",
// "solo en agosto". Sin filtros, la ruta se vigila todos los días.

const DIAS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function validateWatch(w, i) {
  const where = w.label ? `"${w.label}"` : `#${i}`;
  const iata = /^[A-Z]{3}$/;
  if (!iata.test(w.from || '')) throw new Error(`watch ${where}: "from" debe ser un IATA de 3 letras`);
  if (!iata.test(w.to || '')) throw new Error(`watch ${where}: "to" debe ser un IATA de 3 letras`);
  if (w.from === w.to) throw new Error(`watch ${where}: origen y destino iguales`);
  for (const d of w.weekdays ?? []) {
    if (!(d in DIAS)) throw new Error(`watch ${where}: día "${d}" inválido (usá ${Object.keys(DIAS).join('/')})`);
  }
  for (const k of ['dateFrom', 'dateTo']) {
    if (w[k] && !/^\d{4}-\d{2}-\d{2}$/.test(w[k])) throw new Error(`watch ${where}: "${k}" debe ser YYYY-MM-DD`);
  }
  if (w.minSeats != null && (!Number.isInteger(w.minSeats) || w.minSeats < 1)) {
    throw new Error(`watch ${where}: "minSeats" debe ser un entero >= 1`);
  }
  return w;
}

export function loadWatches(raw) {
  const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(list)) throw new Error('watches debe ser un array');
  if (list.length === 0) throw new Error('no hay watches configurados');
  return list.map(validateWatch);
}

/** ¿Este watch aplica a la fecha objetivo? */
export function appliesTo(watch, date) {
  if (watch.enabled === false) return false;
  if (watch.dateFrom && date < watch.dateFrom) return false;
  if (watch.dateTo && date > watch.dateTo) return false;
  if (watch.weekdays?.length) {
    // Mediodía UTC para no cruzar de día por husos.
    const dow = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (!watch.weekdays.some((d) => DIAS[d] === dow)) return false;
  }
  return true;
}

/** Filtros sobre los vuelos que devolvió la API. */
export function matchFlight(watch, f) {
  if (f.seats < (watch.minSeats ?? 1)) return false;
  if (watch.maxTaxes != null && f.taxes != null && f.taxes > watch.maxTaxes) return false;
  if (watch.departAfter && f.departsHHMM && f.departsHHMM < watch.departAfter) return false;
  if (watch.departBefore && f.departsHHMM && f.departsHHMM > watch.departBefore) return false;
  return true;
}

export function watchLabel(w) {
  return w.label || `${w.from}→${w.to}`;
}
