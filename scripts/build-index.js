// Copies the game page (game/index.html, the same file as the Claude artifact) into public/ with the server's
// room connector added. Run on every build so the deployed page always matches game/index.html.
const fs = require('node:fs'), path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'game', 'index.html'), 'utf8');
const i = src.indexOf('<script');
fs.writeFileSync(path.join(__dirname, '..', 'public', 'index.html'), src.slice(0, i) + '<script src="/net.js"></script>\n' + src.slice(i));
console.log('public/index.html built');
