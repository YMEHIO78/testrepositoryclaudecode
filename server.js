// Minimal static server for Railway.
// Swap this out for a real backend (Express routes + a database) as you
// wire up Outlook, Outlook Calendar, and Wave — this just serves the
// front-end mockup in /public so it's deployable as-is.

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.listen(PORT, () => {
  console.log(`Pocket Data Office listening on port ${PORT}`);
});
