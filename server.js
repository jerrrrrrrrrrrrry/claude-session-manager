const express = require("express");
const path = require("path");
const http = require("http");

const PORT = 3001;
const dataReader = require("./src/data-reader.js");

// --- Express Server ---

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept",
  );
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// Get all projects
app.get("/api/projects", (req, res) => {
  const projects = dataReader.getProjects();
  res.json({ success: true, data: projects });
});

// Get all sessions (optionally filtered by project)
app.get("/api/sessions", (req, res) => {
  const project = req.query.project;
  const limit = parseInt(req.query.limit) || 50;

  const sessions = dataReader.getSessions(project, limit);
  res.json({ success: true, data: sessions });
});

// Get token usage statistics
app.get("/api/stats", (req, res) => {
  const stats = dataReader.getStats();
  res.json({
    success: true,
    data: stats,
  });
});

// Get session detail
app.get("/api/sessions/:project/:sessionId", (req, res) => {
  const { project, sessionId } = req.params;
  const session = dataReader.getSession(project, sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: "Session not found" });
  }
  res.json({ success: true, data: session });
});

// Get command history
app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const commands = dataReader.getHistoryCommands(limit);
  res.json({ success: true, data: commands });
});

// Search endpoint
app.get("/api/search", (req, res) => {
  const query = req.query.q || "";
  const limit = parseInt(req.query.limit) || 20;

  if (!query || query.length < 2) {
    return res.json({ success: true, data: { results: [], total: 0 } });
  }

  const results = dataReader.searchAll(query, limit);

  res.json({
    success: true,
    data: {
      results,
      total: results.length,
    },
  });
});

// --- Start ---

const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`Claude Session Manager running on http://localhost:${PORT}`);
});
