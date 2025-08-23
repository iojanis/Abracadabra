import * as Y from "yjs";
import { AbracadabraClient } from "../src/index";
import type { AuthUser, DocumentMetadata, FileMetadata } from "../src/index";

const ROOM_NAME = "abracadabra-example-room";

// --- UI Elements ---
const authSection = document.getElementById("auth-section") as HTMLDivElement;
const mainSection = document.getElementById("main-section") as HTMLDivElement;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const registerForm = document.getElementById(
  "register-form",
) as HTMLFormElement;
const userInfo = document.getElementById("user-info") as HTMLDivElement;
const connectionStatus = document.getElementById(
  "connection-status",
) as HTMLDivElement;

const docList = document.getElementById("doc-list") as HTMLUListElement;
const currentDocTitle = document.getElementById(
  "current-doc-title",
) as HTMLHeadingElement;
const docContent = document.getElementById(
  "doc-content",
) as HTMLTextAreaElement;
const createDocForm = document.getElementById(
  "create-doc-form",
) as HTMLFormElement;
const uploadForm = document.getElementById("upload-form") as HTMLFormElement;
const filesList = document.getElementById("files-list") as HTMLDivElement;

// Add debug elements
const debugSection = document.createElement("div");
debugSection.innerHTML = `
  <div class="debug-panel">
    <h3>🔧 Debug & Testing</h3>
    <div class="debug-buttons">
      <button id="test-connection">Test Connection</button>
      <button id="test-api">Test API</button>
      <button id="fetch-stats">System Stats</button>
      <button id="toggle-offline">Simulate Offline</button>
    </div>
    <div id="debug-log" class="debug-log"></div>
  </div>
`;
document.body.insertBefore(debugSection, document.body.firstChild);

const debugLog = document.getElementById("debug-log") as HTMLDivElement;

function log(
  message: string,
  type: "info" | "error" | "warn" | "success" = "info",
) {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement("div");
  logEntry.className = `log-entry log-${type}`;
  logEntry.innerHTML = `<span class="log-time">[${timestamp}]</span> <span class="log-message">${message}</span>`;
  debugLog.insertBefore(logEntry, debugLog.firstChild);

  // Keep only last 50 entries
  while (debugLog.children.length > 50) {
    debugLog.removeChild(debugLog.lastChild!);
  }

  console.log(`[${type.toUpperCase()}] ${message}`);
}

// --- Client Setup ---
let client: AbracadabraClient | null = null;
let currentUser: AuthUser | null = null;
let activeDocName: string | null = null;
let ytext: Y.Text | null = null;
let isOfflineMode = false;

function initializeClient() {
  log("Initializing Abracadabra Client...", "info");

  if (client) {
    client.destroy();
  }

  client = new AbracadabraClient({
    serverUrl: "http://localhost:8787",
    hocuspocusUrl: "ws://localhost:8787/collaborate",
    roomName: ROOM_NAME,
    enableOffline: true,
    enableWebRTC: false, // Disabled for debugging
    autoReconnect: true,
  });

  setupClientEventHandlers();

  return client
    .connect()
    .then(() => {
      log("✅ Abracadabra Client connected successfully", "success");
      updateConnectionStatus();
    })
    .catch((error) => {
      log(`❌ Failed to connect client: ${error.message}`, "error");
    });
}

function setupClientEventHandlers() {
  if (!client) return;

  // Authentication events
  client.on("auth:login", (user) => {
    currentUser = user;
    log(`🔐 User logged in: ${user.displayName} (${user.username})`, "success");
    showMainInterface();
    loadDocumentIndex();
  });

  client.on("auth:logout", () => {
    currentUser = null;
    log("🔐 User logged out", "info");
    showAuthInterface();
  });

  client.on("auth:error", (error) => {
    log(`🔐 Auth error: ${error.message}`, "error");
  });

  // Connection events
  client.on("connection:open", () => {
    log("🌐 Connected to server", "success");
    updateConnectionStatus();
  });

  client.on("connection:close", () => {
    log("🌐 Disconnected from server", "warn");
    updateConnectionStatus();
  });

  client.on("connection:error", (error) => {
    log(`🌐 Connection error: ${error.message}`, "error");
    updateConnectionStatus();
  });

  // Document events
  client.on("document:loaded", (path, doc) => {
    log(`📄 Document loaded: ${path}`, "success");
  });

  client.on("document:error", (path, error) => {
    log(`📄 Document error for ${path}: ${error.message}`, "error");
  });

  // Sync events
  client.on("sync:start", () => {
    log("🔄 Sync started", "info");
  });

  client.on("sync:complete", () => {
    log("🔄 Sync completed", "success");
  });

  // Network events
  client.on("online", () => {
    log("🌐 Network back online", "success");
    updateConnectionStatus();
  });

  client.on("offline", () => {
    log("🌐 Network went offline", "warn");
    updateConnectionStatus();
  });
}

// --- UI State Management ---
function showAuthInterface() {
  authSection.style.display = "block";
  mainSection.style.display = "none";
  userInfo.textContent = "";
}

function showMainInterface() {
  authSection.style.display = "none";
  mainSection.style.display = "block";

  if (currentUser) {
    userInfo.innerHTML = `
      <div class="user-profile">
        <span class="user-name">${currentUser.displayName}</span>
        <span class="user-email">(${currentUser.email})</span>
        <button id="logout-btn" class="btn btn-sm">Logout</button>
        <button id="profile-btn" class="btn btn-sm">Profile</button>
      </div>
    `;

    document
      .getElementById("logout-btn")
      ?.addEventListener("click", handleLogout);
    document
      .getElementById("profile-btn")
      ?.addEventListener("click", showProfileDialog);
  }
}

function updateConnectionStatus() {
  if (!client) return;

  const status = client.getConnectionStatus();
  const isOnline = client.isOnlineStatus();

  connectionStatus.innerHTML = `
    <div class="connection-indicators">
      <span class="indicator ${isOnline ? "online" : "offline"}">
        ${isOnline ? "🌐 Online" : "🔌 Offline"}
      </span>
      <span class="indicator ${status.hocuspocus ? "connected" : "disconnected"}">
        ${status.hocuspocus ? "🟢 Server" : "🔴 Server"}
      </span>
      <span class="indicator ${status.indexeddb ? "enabled" : "disabled"}">
        ${status.indexeddb ? "💾 Local" : "❌ Local"}
      </span>
      ${status.webrtc ? `<span class="indicator connected">🔗 P2P</span>` : ""}
    </div>
  `;
}

// --- Authentication Handlers ---
async function handleLogin(event: Event) {
  event.preventDefault();
  if (!client) return;

  const formData = new FormData(loginForm);
  const identifier = formData.get("identifier") as string;
  const password = formData.get("password") as string;

  try {
    log(`🔐 Attempting login for: ${identifier}`, "info");
    await client.login({ identifier, password });
  } catch (error) {
    log(
      `❌ Login failed: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    alert("Login failed: " + (error instanceof Error ? error.message : error));
  }
}

async function handleRegister(event: Event) {
  event.preventDefault();
  if (!client) return;

  const formData = new FormData(registerForm);
  const username = formData.get("username") as string;
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  const displayName = formData.get("displayName") as string;

  try {
    log(`🔐 Attempting registration for: ${username}`, "info");
    await client.register({ username, email, password, displayName });
  } catch (error) {
    log(
      `❌ Registration failed: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    alert(
      "Registration failed: " +
        (error instanceof Error ? error.message : error),
    );
  }
}

async function handleLogout() {
  if (!client) return;

  try {
    await client.logout();
  } catch (error) {
    log(
      `❌ Logout error: ${error instanceof Error ? error.message : error}`,
      "error",
    );
  }
}

// --- Document Management ---
async function loadDocumentIndex() {
  if (!client) return;

  try {
    log("📚 Fetching document index...", "info");
    const documents = await client.fetchIndex();
    renderDocumentList(documents);
    log(`📚 Loaded ${documents.length} documents`, "success");
  } catch (error) {
    log(
      `❌ Failed to load document index: ${error instanceof Error ? error.message : error}`,
      "error",
    );
  }
}

function renderDocumentList(documents: DocumentMetadata[]) {
  docList.innerHTML = "";

  documents.forEach((doc) => {
    const li = document.createElement("li");
    li.className = "doc-item";
    li.innerHTML = `
      <div class="doc-info">
        <span class="doc-title">${doc.title || doc.path}</span>
        <span class="doc-path">${doc.path}</span>
        <span class="doc-meta">${doc.isPublic ? "🌍 Public" : "🔒 Private"} • ${new Date(doc.updatedAt).toLocaleDateString()}</span>
      </div>
      <div class="doc-actions">
        <button class="btn btn-sm edit-doc" data-path="${doc.path}">Edit</button>
        <button class="btn btn-sm btn-danger delete-doc" data-path="${doc.path}">Delete</button>
      </div>
    `;

    if (doc.path === activeDocName) {
      li.classList.add("active");
    }

    docList.appendChild(li);
  });

  // Add event listeners
  docList.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const path = target.dataset.path;

    if (!path) return;

    if (target.classList.contains("edit-doc")) {
      await loadDocument(path);
    } else if (target.classList.contains("delete-doc")) {
      if (confirm(`Are you sure you want to delete "${path}"?`)) {
        await deleteDocument(path);
      }
    }
  });
}

async function loadDocument(path: string) {
  if (!client) return;

  try {
    log(`📄 Loading document: ${path}`, "info");

    // Leave current document if any
    if (activeDocName && ytext) {
      client.leaveDocument(activeDocName);
      ytext = null;
    }

    activeDocName = path;
    currentDocTitle.textContent = `Editing: ${path}`;
    docContent.disabled = false;
    docContent.value = "Loading...";

    const subdoc = await client.getDocument(path);
    ytext = subdoc.getText("content");

    // Bind Y.Text to the textarea with proper diff handling
    ytext.observe(() => {
      if (document.activeElement !== docContent) {
        docContent.value = ytext!.toString();
      }
    });

    // Handle user input
    let isUpdating = false;
    docContent.oninput = () => {
      if (isUpdating || !ytext) return;

      isUpdating = true;
      subdoc.transact(() => {
        const currentContent = ytext!.toString();
        const newContent = docContent.value;

        if (currentContent !== newContent) {
          ytext!.delete(0, ytext!.length);
          ytext!.insert(0, newContent);
        }
      });
      isUpdating = false;
    };

    docContent.value = ytext.toString();
    log(`📄 Document loaded successfully: ${path}`, "success");

    // Update UI
    renderDocumentList(await client.fetchIndex());
  } catch (error) {
    log(
      `❌ Failed to load document: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    docContent.value = "";
    docContent.disabled = true;
    activeDocName = null;
  }
}

async function createDocument(event: Event) {
  event.preventDefault();
  if (!client) return;

  const formData = new FormData(createDocForm);
  const path = formData.get("path") as string;
  const title = formData.get("title") as string;
  const description = formData.get("description") as string;
  const isPublic = formData.get("isPublic") === "on";
  const initialContent = formData.get("initialContent") as string;

  try {
    log(`📄 Creating document: ${path}`, "info");
    await client.createDocument(path, {
      title,
      description,
      isPublic,
      initialContent,
    });

    log(`✅ Document created: ${path}`, "success");
    createDocForm.reset();
    await loadDocumentIndex();
    await loadDocument(path);
  } catch (error) {
    log(
      `❌ Failed to create document: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    alert(
      "Failed to create document: " +
        (error instanceof Error ? error.message : error),
    );
  }
}

async function deleteDocument(path: string) {
  if (!client) return;

  try {
    log(`🗑️ Deleting document: ${path}`, "info");
    await client.deleteDocument(path);
    log(`✅ Document deleted: ${path}`, "success");

    if (activeDocName === path) {
      activeDocName = null;
      ytext = null;
      docContent.value = "";
      docContent.disabled = true;
      currentDocTitle.textContent = "Select a document";
    }

    await loadDocumentIndex();
  } catch (error) {
    log(
      `❌ Failed to delete document: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    alert(
      "Failed to delete document: " +
        (error instanceof Error ? error.message : error),
    );
  }
}

// --- File Upload Management ---
async function handleFileUpload(event: Event) {
  event.preventDefault();
  if (!client) return;

  const formData = new FormData(uploadForm);
  const file = formData.get("file") as File;
  const description = formData.get("description") as string;
  const tags = (formData.get("tags") as string)
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t);

  if (!file) {
    alert("Please select a file to upload");
    return;
  }

  try {
    log(`📎 Uploading file: ${file.name}`, "info");
    const fileMetadata = await client.uploadFile(file, {
      description,
      tags,
      documentPath: activeDocName || undefined,
    });

    log(`✅ File uploaded: ${fileMetadata.filename}`, "success");
    uploadForm.reset();
    await loadFilesList();
  } catch (error) {
    log(
      `❌ File upload failed: ${error instanceof Error ? error.message : error}`,
      "error",
    );
    alert(
      "File upload failed: " + (error instanceof Error ? error.message : error),
    );
  }
}

async function loadFilesList() {
  if (!client) return;

  try {
    const files = await client.listFiles({ limit: 20 });
    renderFilesList(files);
  } catch (error) {
    log(
      `❌ Failed to load files: ${error instanceof Error ? error.message : error}`,
      "error",
    );
  }
}

function renderFilesList(files: FileMetadata[]) {
  filesList.innerHTML = "";

  if (files.length === 0) {
    filesList.innerHTML = "<p>No files uploaded yet.</p>";
    return;
  }

  files.forEach((file) => {
    const fileItem = document.createElement("div");
    fileItem.className = "file-item";
    fileItem.innerHTML = `
      <div class="file-info">
        <span class="file-name">${file.filename}</span>
        <span class="file-size">${formatFileSize(file.size)}</span>
        <span class="file-date">${new Date(file.createdAt).toLocaleDateString()}</span>
        ${file.description ? `<p class="file-description">${file.description}</p>` : ""}
        ${file.tags.length > 0 ? `<div class="file-tags">${file.tags.map((tag) => `<span class="tag">${tag}</span>`).join("")}</div>` : ""}
      </div>
      <div class="file-actions">
        ${file.url ? `<a href="${file.url}" target="_blank" class="btn btn-sm">View</a>` : ""}
        <button class="btn btn-sm btn-danger delete-file" data-id="${file.id}">Delete</button>
      </div>
    `;
    filesList.appendChild(fileItem);
  });

  // Add delete handlers
  filesList.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    if (target.classList.contains("delete-file")) {
      const fileId = target.dataset.id!;
      if (confirm("Are you sure you want to delete this file?")) {
        await deleteFile(fileId);
      }
    }
  });
}

async function deleteFile(fileId: string) {
  if (!client) return;

  try {
    await client.deleteFile(fileId);
    log(`✅ File deleted`, "success");
    await loadFilesList();
  } catch (error) {
    log(
      `❌ Failed to delete file: ${error instanceof Error ? error.message : error}`,
      "error",
    );
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// --- Profile Management ---
async function showProfileDialog() {
  if (!client || !currentUser) return;

  const dialog = document.createElement("div");
  dialog.className = "modal-overlay";
  dialog.innerHTML = `
    <div class="modal">
      <h3>User Profile</h3>
      <form id="profile-form">
        <div class="form-group">
          <label>Username</label>
          <input type="text" value="${currentUser.username}" readonly />
        </div>
        <div class="form-group">
          <label>Email</label>
          <input type="email" name="email" value="${currentUser.email}" />
        </div>
        <div class="form-group">
          <label>Display Name</label>
          <input type="text" name="displayName" value="${currentUser.displayName}" />
        </div>
        <div class="form-actions">
          <button type="submit" class="btn">Update Profile</button>
          <button type="button" class="btn btn-secondary" id="cancel-profile">Cancel</button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(dialog);

  const form = dialog.querySelector("#profile-form") as HTMLFormElement;
  const cancelBtn = dialog.querySelector(
    "#cancel-profile",
  ) as HTMLButtonElement;

  form.onsubmit = async (event) => {
    event.preventDefault();
    const formData = new FormData(form);

    try {
      await client!.updateProfile({
        email: formData.get("email") as string,
        displayName: formData.get("displayName") as string,
      });
      log("✅ Profile updated", "success");
      document.body.removeChild(dialog);
      showMainInterface(); // Refresh user info
    } catch (error) {
      log(
        `❌ Profile update failed: ${error instanceof Error ? error.message : error}`,
        "error",
      );
    }
  };

  cancelBtn.onclick = () => {
    document.body.removeChild(dialog);
  };

  dialog.onclick = (event) => {
    if (event.target === dialog) {
      document.body.removeChild(dialog);
    }
  };
}

// --- Debug Functions ---
async function testConnection() {
  log("🔧 Testing connection...", "info");

  try {
    const response = await fetch("http://localhost:8787/health");
    const data = await response.json();
    log(`✅ Server health: ${data.status}`, "success");
  } catch (error) {
    log(
      `❌ Connection test failed: ${error instanceof Error ? error.message : error}`,
      "error",
    );
  }
}

async function testAPI() {
  log("🔧 Testing API endpoints...", "info");

  const endpoints = ["/api/auth/profile", "/api/documents/", "/api/uploads/"];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`http://localhost:8787${endpoint}`, {
        headers: client?.isAuthenticated()
          ? { Authorization: `Bearer ${(client as any).config.token}` }
          : {},
      });

      log(
        `${response.ok ? "✅" : "❌"} ${endpoint}: ${response.status}`,
        response.ok ? "success" : "error",
      );
    } catch (error) {
      log(`❌ ${endpoint}: Network error`, "error");
    }
  }
}

async function fetchSystemStats() {
  if (!client?.isAuthenticated()) {
    log("❌ Authentication required for system stats", "error");
    return;
  }

  try {
    const stats = await client.getSystemStats();
    log(`📊 System stats: ${JSON.stringify(stats, null, 2)}`, "info");
  } catch (error) {
    log(
      `❌ Failed to fetch system stats: ${error instanceof Error ? error.message : error}`,
      "error",
    );
  }
}

function toggleOfflineMode() {
  isOfflineMode = !isOfflineMode;

  if (isOfflineMode) {
    // Simulate offline mode
    client?.disconnect();
    log("🔌 Simulating offline mode", "warn");
  } else {
    // Go back online
    client?.connect();
    log("🌐 Back online", "success");
  }
}

// --- Event Listeners ---
loginForm.addEventListener("submit", handleLogin);
registerForm.addEventListener("submit", handleRegister);
createDocForm.addEventListener("submit", createDocument);
uploadForm.addEventListener("submit", handleFileUpload);

document
  .getElementById("test-connection")
  ?.addEventListener("click", testConnection);
document.getElementById("test-api")?.addEventListener("click", testAPI);
document
  .getElementById("fetch-stats")
  ?.addEventListener("click", fetchSystemStats);
document
  .getElementById("toggle-offline")
  ?.addEventListener("click", toggleOfflineMode);

// --- Initial Setup ---
window.addEventListener("load", async () => {
  log("🎩 Abracadabra Client Example starting...", "info");

  await initializeClient();

  // Check if user is already authenticated
  if (client?.isAuthenticated()) {
    try {
      const user = await client.getUserProfile();
      currentUser = user;
      showMainInterface();
      await loadDocumentIndex();
      await loadFilesList();
    } catch (error) {
      log("❌ Failed to load user profile, showing login", "warn");
      showAuthInterface();
    }
  } else {
    showAuthInterface();
  }

  updateConnectionStatus();

  log("🎉 Application initialized successfully!", "success");
  log(
    "💡 You can create test users by running the create-test-users.ts script",
    "info",
  );
  log("💡 Test users: admin/admin123, alice/alice123, bob/bob123", "info");
});

// Clean up on page leave
window.addEventListener("beforeunload", () => {
  if (client) {
    client.destroy();
  }
});
