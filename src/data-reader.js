const path = require("path");
const fs = require("fs");
const os = require("os");

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const HISTORY_FILE = path.join(CLAUDE_DIR, "history.jsonl");

// Path mapping cache: encodedDir -> realPath
// e.g., "-mnt-f-claude-hotpulse" -> "/mnt/f/claude/hotpulse"
const pathMapping = {};

// --- In-memory Cache for Session Metadata ---
let sessionCache = {
  projects: null, // Cached getProjects result
  sessions: new Map(), // projectId -> [session metadata]
  stats: null, // Cached getStats result
  lastUpdate: 0,
};
const CACHE_TTL = 5000; // 5 seconds cache TTL

// Invalidate cache on file changes
function invalidateCache() {
  sessionCache.projects = null;
  sessionCache.stats = null;
  // Keep sessions map but they'll be refreshed on next access
}

// Initialize chokidar watcher (lazy loaded)
let fileWatcher = null;

function initWatcher() {
  if (fileWatcher) return;

  try {
    const chokidar = require("chokidar");
    fileWatcher = chokidar.watch(PROJECTS_DIR, {
      ignored: /(^|[\/\\])\../,
      persistent: true,
      ignoreInitial: true,
      depth: 1,
    });

    fileWatcher.on("change", (filePath) => {
      if (filePath.endsWith(".jsonl")) {
        invalidateCache();
      }
    });

    fileWatcher.on("add", (filePath) => {
      if (filePath.endsWith(".jsonl")) {
        invalidateCache();
      }
    });

    fileWatcher.on("unlink", (filePath) => {
      if (filePath.endsWith(".jsonl")) {
        invalidateCache();
      }
    });

    console.log("[data-reader] File watcher initialized");
  } catch (err) {
    console.error("[data-reader] Failed to initialize watcher:", err.message);
  }
}

// --- Path Resolution ---

/**
 * Get real project path from session JSONL file's cwd field.
 * Reads the first session file's first progress message to extract cwd.
 * Caches result for subsequent calls.
 */
function getRealProjectPath(encodedDir) {
  // Return cached path if available
  if (pathMapping[encodedDir]) {
    return pathMapping[encodedDir];
  }

  const projectDir = path.join(PROJECTS_DIR, encodedDir);
  if (!dirExists(projectDir)) {
    return null;
  }

  // Find first session file
  const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) {
    return null;
  }

  // Read first session file to find cwd in progress message
  const sessionPath = path.join(projectDir, files[0]);
  const messages = safeReadJSONL(sessionPath);

  let realPath = null;
  for (const msg of messages) {
    // Look for progress message with cwd in data
    if (msg.type === "progress" && msg.data?.cwd) {
      realPath = msg.data.cwd;
      break;
    }
    // Also check root-level cwd field
    if (msg.cwd) {
      realPath = msg.cwd;
      break;
    }
  }

  // Cache the result
  if (realPath) {
    pathMapping[encodedDir] = realPath;
  }

  return realPath;
}

// --- Helpers ---

function safeReadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeReadJSONL(filePath, limit = null) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    const results = [];
    const max = limit || lines.length;
    for (let i = 0; i < max && i < lines.length; i++) {
      try {
        results.push(JSON.parse(lines[i]));
      } catch {
        // Skip invalid JSON lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

function dirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

// --- Data Readers ---

function getProjects() {
  // Use cache if valid
  if (
    sessionCache.projects &&
    Date.now() - sessionCache.lastUpdate < CACHE_TTL
  ) {
    return sessionCache.projects;
  }

  // Ensure watcher is initialized
  initWatcher();

  if (!dirExists(PROJECTS_DIR)) return [];

  const entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, entry.name);

    // Count sessions
    const files = fs
      .readdirSync(projectPath)
      .filter((f) => f.endsWith(".jsonl"));
    const sessions = files.map((f) => {
      const sessionPath = path.join(projectPath, f);
      const stats = fs.statSync(sessionPath);
      // Get last message as timestamp reference
      const messages = safeReadJSONL(sessionPath, 1);
      const lastMessage = messages[messages.length - 1];
      return {
        id: f.replace(".jsonl", ""),
        name: f.replace(".jsonl", ""),
        fileSize: stats.size,
        lastModified: stats.mtime.toISOString(),
        lastMessage: lastMessage?.timestamp || stats.mtime.toISOString(),
      };
    });

    projects.push({
      name: entry.name,
      path: entry.name,
      sessionCount: sessions.length,
      sessions: sessions.slice(0, 10), // Limit for list view
    });
  }

  // Cache result
  sessionCache.projects = projects;
  sessionCache.lastUpdate = Date.now();

  return projects;
}

function getSessionDetail(projectName, sessionId) {
  const sessionPath = path.join(
    PROJECTS_DIR,
    projectName,
    `${sessionId}.jsonl`,
  );
  if (!fs.existsSync(sessionPath)) return null;

  const messages = safeReadJSONL(sessionPath);
  return {
    project: projectName,
    sessionId,
    messageCount: messages.length,
    messages,
  };
}

function getHistoryCommands(limit = 100) {
  if (!fs.existsSync(HISTORY_FILE)) return [];

  try {
    const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .filter((l) => l.trim());
    const commands = [];

    for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
      try {
        commands.push(JSON.parse(lines[i]));
      } catch {
        // Skip invalid lines
      }
    }

    return commands.reverse(); // Most recent first
  } catch {
    return [];
  }
}

// --- Search Implementation ---

function searchSessions(query, limit = 20) {
  const results = [];
  const queryLower = query.toLowerCase();

  if (!dirExists(PROJECTS_DIR)) return results;

  const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(PROJECTS_DIR, project.name);
    const files = fs
      .readdirSync(projectPath)
      .filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const sessionPath = path.join(projectPath, file);
      const messages = safeReadJSONL(sessionPath);

      for (const msg of messages) {
        // Search in various fields
        let searchableText = "";
        let matchType = null;

        // Check for user messages
        if (msg.type === "user" && msg.message?.content) {
          const content = msg.message.content;
          if (typeof content === "string") {
            // Simple string content
            searchableText = content;
            matchType = "user";
          } else if (Array.isArray(content)) {
            // Array of content blocks
            searchableText = content.map((c) => c.text || c).join(" ");
            matchType = "user";
          } else if (content.text) {
            // Object with text field
            searchableText = content.text;
            matchType = "user";
          }
        }

        // Check for assistant messages
        if (msg.type === "assistant" && msg.message?.content) {
          const content = msg.message.content;
          if (typeof content === "string") {
            searchableText = content;
            matchType = "assistant";
          } else if (Array.isArray(content)) {
            searchableText = content
              .map((c) => c.text || JSON.stringify(c))
              .join(" ");
            matchType = "assistant";
          } else if (content.text) {
            searchableText = content.text;
            matchType = "assistant";
          }
        }

        // Also check data field for hook_progress type messages
        if (msg.data?.type === "hook_progress" && msg.data?.command) {
          searchableText = msg.data.command;
          matchType = "system";
        }

        if (
          searchableText &&
          searchableText.toLowerCase().includes(queryLower)
        ) {
          results.push({
            sessionId: file.replace(".jsonl", ""),
            project: project.name,
            timestamp: msg.timestamp || msg.snapshot?.timestamp,
            matchedContent: searchableText.substring(0, 200),
            matchType,
          });

          if (results.length >= limit) break;
        }
      }

      if (results.length >= limit) break;
    }

    if (results.length >= limit) break;
  }

  return results;
}

function searchCommands(query, limit = 20) {
  const results = [];
  const queryLower = query.toLowerCase();

  if (!fs.existsSync(HISTORY_FILE)) return results;

  const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
  const lines = raw.trim().split("\n");

  for (const line of lines) {
    try {
      const cmd = JSON.parse(line);
      if (cmd.display && cmd.display.toLowerCase().includes(queryLower)) {
        results.push({
          sessionId: cmd.sessionId,
          project: cmd.project,
          timestamp: new Date(cmd.timestamp).toISOString(),
          matchedContent: cmd.display,
          matchType: "command",
        });

        if (results.length >= limit) break;
      }
    } catch {
      // Skip invalid lines
    }
  }

  return results;
}

function searchAll(query, limit = 20) {
  const sessionResults = searchSessions(query, limit);
  const commandResults = searchCommands(query, limit);

  // Merge and sort by timestamp
  const merged = [...sessionResults, ...commandResults];
  merged.sort((a, b) => {
    const tsA = a.timestamp || "";
    const tsB = b.timestamp || "";
    return tsB.localeCompare(tsA);
  });

  return merged.slice(0, limit);
}

// --- Stats Implementation ---

function getStats() {
  // Use cache if valid
  if (sessionCache.stats && Date.now() - sessionCache.lastUpdate < CACHE_TTL) {
    return sessionCache.stats;
  }

  // Ensure watcher is initialized
  initWatcher();

  const global = {
    totalTokens: 0,
    totalSessions: 0,
    totalProjects: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
  const byProject = [];
  const byDay = {};

  if (!dirExists(PROJECTS_DIR)) {
    return { global, byProject: [], byDay: [] };
  }

  const projects = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });

  for (const project of projects) {
    if (!project.isDirectory()) continue;

    const projectPath = path.join(PROJECTS_DIR, project.name);
    const files = fs
      .readdirSync(projectPath)
      .filter((f) => f.endsWith(".jsonl"));

    let projectTokens = 0;
    let projectInput = 0;
    let projectOutput = 0;

    // Single pass: read each file once and compute all stats
    for (const file of files) {
      const sessionPath = path.join(projectPath, file);
      const messages = safeReadJSONL(sessionPath);

      global.totalSessions++;

      // Track unique days for this session
      const sessionDays = new Set();

      for (const msg of messages) {
        // Track session days
        if (msg.timestamp) {
          const day = msg.timestamp.substring(0, 10);
          sessionDays.add(day);
        }

        // Accumulate tokens
        if (msg.message?.usage) {
          const input = msg.message.usage.input_tokens || 0;
          const output = msg.message.usage.output_tokens || 0;
          global.totalInputTokens += input;
          global.totalOutputTokens += output;
          projectInput += input;
          projectOutput += output;

          // Track by day
          if (msg.timestamp) {
            const day = msg.timestamp.substring(0, 10);
            if (!byDay[day]) {
              byDay[day] = {
                date: day,
                tokens: 0,
                sessions: 0,
                inputTokens: 0,
                outputTokens: 0,
              };
            }
            byDay[day].inputTokens += input;
            byDay[day].outputTokens += output;
            byDay[day].tokens += input + output;
          }
        }
      }

      // Count session for each unique day
      for (const day of sessionDays) {
        if (byDay[day]) {
          byDay[day].sessions++;
        }
      }

      projectTokens = projectInput + projectOutput;
    }

    byProject.push({
      project: project.name,
      projectPath: getRealProjectPath(project.name) || project.name,
      tokens: projectTokens,
      sessions: files.length,
      inputTokens: projectInput,
      outputTokens: projectOutput,
    });
  }

  global.totalProjects = byProject.length;
  global.totalTokens = global.totalInputTokens + global.totalOutputTokens;

  // Convert byDay to array and sort
  const byDayArray = Object.values(byDay).sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  // Cache result
  const result = {
    global,
    byProject,
    byDay: byDayArray,
  };
  sessionCache.stats = result;
  sessionCache.lastUpdate = Date.now();

  return result;
}

// --- Sessions (list all sessions with metadata) ---

function getSessions(projectId = null, limit = 50) {
  // Check cache first
  const cacheKey = `${projectId || "all"}:${limit}`;
  const cached = sessionCache.sessions.get(cacheKey);
  if (cached && Date.now() - sessionCache.lastUpdate < CACHE_TTL) {
    return cached;
  }

  // Ensure watcher is initialized
  initWatcher();

  let allSessions = [];
  const projects = projectId
    ? [projectId]
    : fs
        .readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

  for (const proj of projects) {
    const projectPath = path.join(PROJECTS_DIR, proj);
    if (!dirExists(projectPath)) continue;

    const files = fs
      .readdirSync(projectPath)
      .filter((f) => f.endsWith(".jsonl"));

    for (const file of files.slice(0, limit)) {
      const sessionPath = path.join(projectPath, file);
      const messages = safeReadJSONL(sessionPath);

      if (messages.length === 0) continue;

      // Get metadata from first and last messages
      const firstMsg = messages[0];
      const lastMsg = messages[messages.length - 1];

      // Extract slug and preview from messages (skip meta and command messages)
      let preview = "";
      let slug = null;

      // First pass: extract slug from all messages
      for (const msg of messages) {
        if (msg.slug && slug === null) {
          slug = msg.slug;
        }
      }

      // Second pass: find preview from user messages
      for (const msg of messages) {
        // Skip meta messages
        if (msg.isMeta === true) continue;

        if (msg.type === "user" && msg.message?.content) {
          // Content can be string or array
          let text = "";
          if (typeof msg.message.content === "string") {
            text = msg.message.content;
          } else if (Array.isArray(msg.message.content)) {
            const textContent = msg.message.content.find(
              (c) => c.type === "text",
            );
            text = textContent?.text || "";
          }

          // Skip command messages (system noise)
          if (
            text.startsWith("<local-command-") ||
            text.startsWith("<command-name>")
          ) {
            continue;
          }

          if (text) {
            preview = text.substring(0, 100).replace(/\n/g, " ");
            break;
          }
        }
      }

      // Calculate token usage and filter message count
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let messageCount = 0;
      for (const msg of messages) {
        // Only count user/assistant messages excluding meta
        if (!msg.isMeta && (msg.type === "user" || msg.type === "assistant")) {
          messageCount++;
        }
        if (msg.message?.usage) {
          totalInputTokens += msg.message.usage.input_tokens || 0;
          totalOutputTokens += msg.message.usage.output_tokens || 0;
        }
      }

      allSessions.push({
        sessionId: file.replace(".jsonl", ""),
        projectId: proj,
        projectPath: getRealProjectPath(proj) || proj,
        timestamp: firstMsg.timestamp,
        lastMessage: lastMsg.timestamp,
        preview: preview || "(no user messages)",
        slug,
        messageCount,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
      });
    }
  }

  // Sort by timestamp descending
  allSessions.sort((a, b) =>
    (b.timestamp || "").localeCompare(a.timestamp || ""),
  );

  const result = allSessions.slice(0, limit);

  // Cache result
  sessionCache.sessions.set(cacheKey, result);
  sessionCache.lastUpdate = Date.now();

  return result;
}

// --- Get full session ---

function getSession(projectName, sessionId) {
  // Path traversal protection: resolve the path and verify it stays within PROJECTS_DIR
  const resolved = path.resolve(
    PROJECTS_DIR,
    projectName,
    `${sessionId}.jsonl`,
  );
  if (!resolved.startsWith(PROJECTS_DIR)) {
    return null; // Invalid path - potential path traversal attack
  }

  const sessionPath = resolved;
  if (!fs.existsSync(sessionPath)) return null;

  const messages = safeReadJSONL(sessionPath);
  return {
    project: projectName,
    sessionId,
    messageCount: messages.length,
    messages,
  };
}

// --- Exports ---

module.exports = {
  getProjects,
  getSessions,
  getSession,
  getSessionDetail,
  getHistoryCommands,
  searchSessions,
  searchCommands,
  searchAll,
  getStats,
  // Also export helpers for potential external use
  safeReadJSON,
  safeReadJSONL,
  dirExists,
};
