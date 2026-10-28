import * as http from "http";
import * as fs from "fs";
import * as path from "path";

const PORT = process.env.PORT || 4200;
const HTML_FILE = path.join(__dirname, "../src/index.html");

const server = http.createServer((req, res) => {
  if (fs.existsSync(HTML_FILE)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(HTML_FILE));
  } else {
    res.writeHead(404);
    res.end("Web Studio index.html not found");
  }
});

server.listen(PORT, () => {
  console.log(`Angular Web Studio running at http://localhost:${PORT}`);
});
