import { createServer } from "node:http";

export function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(record);
      Promise.resolve(handler(record, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: "http://127.0.0.1:" + port,
        requests,
        close() {
          return new Promise((done) => {
            server.close(() => done());
            if (typeof server.closeAllConnections === "function") server.closeAllConnections();
          });
        },
      });
    });
  });
}

export function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
