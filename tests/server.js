// A tiny static file server for the tests: serves the site (the folder above this one) on port 4173.
const http = require("http"), fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, ".."), types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".fasta": "text/plain", ".png": "image/png" };
http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html", file = path.join(root, rel);
  if (!file.startsWith(root) || rel.startsWith("tests") || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }); fs.createReadStream(file).pipe(res);
}).listen(4173, () => console.log("site on http://localhost:4173"));
