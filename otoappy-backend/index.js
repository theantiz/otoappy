// job-autofill-backend/index.js

const http = require("http");

const createApp = require("./app");

const PORT = Number(process.env.PORT) || 4000;

const app = createApp();
const server = http.createServer(app);

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} in use, try a different port`);
    return;
  }
  console.error("Backend server error:", err);
});

server.listen(PORT, () => {
  console.log(`Job Autofill Backend listening at http://localhost:${PORT}`);
});

