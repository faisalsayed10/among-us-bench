// Serverless filesystem isn't persistent — public deploys can't write metrics.
// Return ok so the client doesn't error; batches should run via `npm run bench`
// against a local server.js instead.
export default function handler(_req, res) {
  res.status(200).json({ ok: true, note: 'metrics logging disabled on serverless deploy' });
}
