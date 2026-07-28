import { runRadar } from '../src/radar.js';


export default async function handler(req, res) {
  // Vercel manda Authorization: Bearer $CRON_SECRET cuando la env var existe.
  // Sin este check la URL queda pública y cualquiera dispara requests con tu sesión.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const out = await runRadar({ date: req.query?.date });
    // Si devolvemos 200 en un fallo, Vercel marca el cron como exitoso y el
    // problema queda invisible en el dashboard.
    return res.status(out.ok === false ? 500 : 200).json({ ok: true, ...out });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
