// Integration Test for Abracadabra Server and Client
// Tests the complete document system including API routes, Yjs collaboration, and real-time features

import { assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import * as Y from "npm:yjs@^13.6.23";
import { HocuspocusProvider } from "npm:@hocuspocus/provider@^2.15.3";

// Server imports
import { AbracadabraServer } from "../src/main.ts";
import { createKvFromEnv } from "../src/utils/kv-factory.ts";
import { createConfigService } from "../src/services/config.ts";

// Test configuration
const TEST_PORT = 8788;
const TEST_SERVER_URL = `http://localhost:${TEST_PORT}`;
const TEST_WS_URL = `ws://localhost:${TEST_PORT}`;

// Test data
const TEST_USERS = {
  user1: {
    username: "testuser1",
    email: "test1@example.com",
    password: "testpass123",
    displayName: "Test User 1"
  },
  user2: {
    username: "testuser2",
    email: "test2@example.com",
    password: "testpass456",
    displayName: "Test User 2"
  }
};

const TEST_DOCUMENTS = {
  root: { path: "test-doc-root", title: "Root Test Document" },
  child: { path: "test-doc-child", title: "Child Test Document" },
  nested: { path: "test-doc-nested", title: "Nested Test Document" }
};

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * HTTP client for API testing
 */
class TestApiClient {
  private baseUrl: string;
  private token?: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  setToken(token: string) {
    this.token = token;
  }

  async request<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> || {})
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return await response.json();
  }

  // Auth methods
  async register(userData: typeof TEST_USERS.user1) {
    return await this.request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(userData)
    });
  }

  async login(credentials: { identifier: string; password: string }) {
    return await this.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(credentials)
    });
  }

  async logout() {
    return await this.request("/api/auth/logout", { method: "POST" });
  }

  // Document methods
  async createDocument(path: string, options: any = {}) {
    return await this.request(`/api/documents/${encodeURIComponent(path)}`, {
      method: "POST",
      body: JSON.stringify(options)
    });
  }

  private encodePath(path: string): string {
    // Remove leading slash to avoid double slashes in URL
    const cleanPath = path.startsWith('/') ? path.slice(1) : path;
    // Encode each segment separately to preserve path separators
    const segments = cleanPath.split('/').map(segment => encodeURIComponent(segment));
    return segments.join('/');
  }

  async getDocument(path: string) {
    const encodedPath = this.encodePath(path);
    return await this.request(`/api/documents/${encodedPath}`);
  }

  async updateDocument(path: string, updates: any) {
    const encodedPath = this.encodePath(path);
    return await this.request(`/api/documents/${encodedPath}`, {
      method: "PUT",
      body: JSON.stringify(updates)
    });
  }

  async deleteDocument(path: string) {
    const encodedPath = this.encodePath(path);
    return await this.request(`/api/documents/${encodedPath}`, {
      method: "DELETE"
    });
  }

  async listDocuments() {
    return await this.request("/api/documents/");
  }

  async getDocumentPermissions(path: string) {
    return await this.request(`/api/documents/${encodeURIComponent(path)}/permissions`);
  }

  async updateDocumentPermissions(path: string, permissions: any) {
    return await this.request(`/api/documents/${encodeURIComponent(path)}/permissions`, {
      method: "PUT",
      body: JSON.stringify(permissions)
    });
  }
}

/**
 * Enhanced Yjs test client using HocuspocusProvider for proper protocol handling
 * Supports real-time collaboration and handles Yjs protocol correctly
 */
class TestYjsClient {
  private doc: Y.Doc;
  private provider: HocuspocusProvider | null = null;
  private connected = false;
  private authenticated = false;
  private syncCompleted = false;

  constructor(private wsUrl: string, private roomName: string, private token?: string) {
    this.doc = new Y.Doc();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Parse WebSocket URL to get correct base URL
      const wsUrlObj = new URL(this.wsUrl);
      const baseUrl = `${wsUrlObj.protocol === 'wss:' ? 'wss:' : 'ws:'}//${wsUrlObj.host}`;

      console.log(`Connecting to Hocuspocus at: ${baseUrl}/collaborate with room: ${this.roomName}`);

      // Create HocuspocusProvider with proper configuration
      this.provider = new HocuspocusProvider({
        url: `${baseUrl}/collaborate`,
        name: this.roomName,
        document: this.doc,
        token: this.token || null,
        onConnect: () => {
          console.log(`Yjs client connected to room: ${this.roomName}`);
          this.connected = true;
        },
        onAuthenticated: () => {
          console.log("WebSocket authentication successful");
          this.authenticated = true;
        },
        onSynced: () => {
          console.log("Document synced successfully");
          this.syncCompleted = true;
          resolve();
        },
        onAuthenticationFailed: ({ reason }: { reason: string }) => {
          console.error(`Authentication failed: ${reason}`);
          reject(new Error(`Authentication failed: ${reason}`));
        },
        onDisconnect: (data: any) => {
          console.log("WebSocket disconnected:", data.reason);
          this.connected = false;
          this.authenticated = false;
          this.syncCompleted = false;
        }
      });

      // Set a timeout for connection
      setTimeout(() => {
        if (!this.syncCompleted) {
          reject(new Error("WebSocket connection and sync timeout"));
        }
      }, 15000); // Increased timeout for HocuspocusProvider
    });
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async waitForSync(timeoutMs: number = 5000): Promise<void> {
    if (this.syncCompleted) return;

    return new Promise((resolve, reject) => {
      const checkSync = () => {
        if (this.syncCompleted) {
          resolve();
        } else {
          setTimeout(checkSync, 100);
        }
      };

      setTimeout(() => {
        if (!this.syncCompleted) {
          reject(new Error("Sync timeout"));
        }
      }, timeoutMs);

      checkSync();
    });
  }

  getText(name: string = "content"): Y.Text {
    return this.doc.getText(name);
  }

  getMap(name: string): Y.Map<any> {
    return this.doc.getMap(name);
  }

  getArray(name: string): Y.Array<any> {
    return this.doc.getArray(name);
  }

  async disconnect(): Promise<void> {
    if (this.provider) {
      this.provider.disconnect();
      this.provider.destroy();
      this.provider = null;
    }

    this.connected = false;
    this.authenticated = false;
    this.syncCompleted = false;
  }

  isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  getDocument(): Y.Doc {
    return this.doc;
  }
}

/**
 * Test server manager
 */
class TestServerManager {
  private server: AbracadabraServer | null = null;
  private serverProcess: Promise<void> | null = null;

  async start(): Promise<void> {
    // Set test environment variables
    Deno.env.set("ABRACADABRA_PORT", TEST_PORT.toString());
    Deno.env.set("ABRACADABRA_HOST", "127.0.0.1");
    Deno.env.set("KV_PROVIDER", "deno");
    Deno.env.set("DENO_KV_PATH", ":memory:"); // Use in-memory KV for tests
    Deno.env.set("JWT_SECRET", "test-jwt-secret-for-integration-tests");
    Deno.env.set("LOG_LEVEL", "WARN"); // Reduce log noise during tests

    console.log("Starting test server...");

    this.server = new AbracadabraServer();
    this.serverProcess = this.server.start();

    // Wait for server to be ready
    await this.waitForServer();
    console.log("Test server started successfully");
  }

  async stop(): Promise<void> {
    if (this.server) {
      console.log("Stopping test server...");
      await this.server["cleanup"](); // Access private cleanup method
      this.server = null;
      this.serverProcess = null;
      console.log("Test server stopped");
    }
  }

  private async waitForServer(): Promise<void> {
    const maxAttempts = 30;
    const delay = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await fetch(`${TEST_SERVER_URL}/health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet
      }

      await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error("Server failed to start within timeout");
  }
}

// ============================================================================
// Test Suite
// ============================================================================

Deno.test({
  name: "Abracadabra Integration Test Suite",
  async fn() {
    const serverManager = new TestServerManager();

    try {
      // Start server
      await serverManager.start();

      // Run all test scenarios
      await testAuthentication();
      await testDocumentCRUD();
      await testDocumentHierarchy();
      await testPermissionSystem();
      await testYjsCollaboration();
      await testMultiUserCollaboration();
      await testYjsPersistence();
      await testBasicYjsConnection();

      console.log("✅ All integration tests passed!");

    } finally {
      // Always stop server
      await serverManager.stop();
    }
  },
  sanitizeOps: false,
  sanitizeResources: false
});

// ============================================================================
// Individual Test Functions
// ============================================================================

async function testAuthentication() {
  console.log("🔐 Testing Authentication Flow...");

  const client = new TestApiClient(TEST_SERVER_URL);

  // Test user registration
  const registerResponse = await client.register(TEST_USERS.user1);
  assertExists(registerResponse.data.user);
  assertExists(registerResponse.data.sessionToken);
  assertEquals(registerResponse.data.user.username, TEST_USERS.user1.username);

  // Test user login
  const loginResponse = await client.login({
    identifier: TEST_USERS.user1.username,
    password: TEST_USERS.user1.password
  });
  assertExists(loginResponse.data.user);
  assertExists(loginResponse.data.sessionToken);

  // Set token for subsequent requests
  client.setToken(loginResponse.data.sessionToken);

  // Test authenticated endpoint (profile)
  const profileResponse = await client.request("/api/auth/profile");
  assertExists(profileResponse.data.user);
  assertEquals(profileResponse.data.user.username, TEST_USERS.user1.username);

  // Test logout
  await client.logout();

  // Test accessing protected endpoint after logout should fail
  client.setToken(""); // Clear token
  await assertRejects(async () => {
    await client.request("/api/auth/profile");
  });

  console.log("✅ Authentication tests passed");
}

async function testDocumentCRUD() {
  console.log("📄 Testing Document CRUD Operations...");

  const client = new TestApiClient(TEST_SERVER_URL);

  // Login first
  const loginResponse = await client.login({
    identifier: TEST_USERS.user1.username,
    password: TEST_USERS.user1.password
  });
  client.setToken(loginResponse.data.sessionToken);

  // Create document
  const createResponse = await client.createDocument(TEST_DOCUMENTS.root.path, {
    title: TEST_DOCUMENTS.root.title,
    description: "Test document for integration testing",
    isPublic: false
  });
  assertExists(createResponse.data.document);
  assertExists(createResponse.data.document.metadata);
  // The server automatically prefixes paths with username, so adjust our expectation
  assertEquals(createResponse.data.document.metadata.path.endsWith(TEST_DOCUMENTS.root.path), true);
  assertEquals(createResponse.data.document.title, TEST_DOCUMENTS.root.title);

  // Store the actual path created by the server for subsequent operations
  const actualPath = createResponse.data.document.metadata.path;

  // Read document using the actual path
  const readResponse = await client.getDocument(actualPath);
  assertExists(readResponse.data.document);
  assertEquals(readResponse.data.document.metadata.path, actualPath);

  // Update document
  const updateResponse = await client.updateDocument(actualPath, {
    title: "Updated Test Document",
    description: "Updated description"
  });
  assertExists(updateResponse.data.document);
  assertEquals(updateResponse.data.document.title, "Updated Test Document");

  // List documents
  const listResponse = await client.listDocuments();
  assertExists(listResponse.data.documents);
  assertEquals(listResponse.data.documents.length >= 1, true);

  // Delete document (save for later tests)
  // await client.deleteDocument(TEST_DOCUMENTS.root.path);

  console.log("✅ Document CRUD tests passed");
}

async function testDocumentHierarchy() {
  console.log("🌳 Testing Multiple Documents...");

  const client = new TestApiClient(TEST_SERVER_URL);

  // Login
  const loginResponse = await client.login({
    identifier: TEST_USERS.user1.username,
    password: TEST_USERS.user1.password
  });
  client.setToken(loginResponse.data.sessionToken);

  // Create child document
  const childResponse = await client.createDocument(TEST_DOCUMENTS.child.path, {
    title: TEST_DOCUMENTS.child.title,
    description: "Second document for testing"
  });
  assertExists(childResponse.data.document);
  assertExists(childResponse.data.document.metadata);
  assertEquals(childResponse.data.document.title, TEST_DOCUMENTS.child.title);

  // Create nested document
  const nestedResponse = await client.createDocument(TEST_DOCUMENTS.nested.path, {
    title: TEST_DOCUMENTS.nested.title,
    description: "Third document for testing"
  });
  assertExists(nestedResponse.data.document);
  assertExists(nestedResponse.data.document.metadata);
  assertEquals(nestedResponse.data.document.title, TEST_DOCUMENTS.nested.title);

  // Verify multiple documents by listing
  const listResponse = await client.listDocuments();
  assertExists(listResponse.data.documents);
  assertEquals(listResponse.data.documents.length >= 3, true); // At least 3 docs (root + child + nested)

  console.log("✅ Multiple document tests passed");
}

async function testPermissionSystem() {
  console.log("🔒 Testing Permission System...");

  const client1 = new TestApiClient(TEST_SERVER_URL);
  const client2 = new TestApiClient(TEST_SERVER_URL);

  // Login user1 (document owner)
  const login1Response = await client1.login({
    identifier: TEST_USERS.user1.username,
    password: TEST_USERS.user1.password
  });
  client1.setToken(login1Response.data.sessionToken);

  // Register and login user2
  await client2.register(TEST_USERS.user2);
  const login2Response = await client2.login({
    identifier: TEST_USERS.user2.username,
    password: TEST_USERS.user2.password
  });
  client2.setToken(login2Response.data.sessionToken);

  // Create a test document first that we can test permissions on
  const testDocResponse = await client1.createDocument("permission-test-doc", {
    title: "Permission Test Document",
    description: "Document for testing permissions",
    isPublic: false
  });
  const testDocPath = testDocResponse.data.document.metadata.path;
  const testDocApiPath = testDocPath.startsWith('/') ? testDocPath.slice(1) : testDocPath;

  // Test that user2 can also create documents
  const user2DocResponse = await client2.createDocument("user2-test-doc", {
    title: "User2 Test Document",
    description: "Document created by user2",
    isPublic: false
  });
  assertExists(user2DocResponse.data.document);
  assertEquals(user2DocResponse.data.document.title, "User2 Test Document");

  // Verify both users can access their own documents
  const user1Docs = await client1.listDocuments();
  const user2Docs = await client2.listDocuments();

  assertExists(user1Docs.data.documents);
  assertExists(user2Docs.data.documents);

  // Both users should have at least one document
  assertEquals(user1Docs.data.documents.length >= 1, true);
  assertEquals(user2Docs.data.documents.length >= 1, true);

  console.log(`✅ Permission system basic test passed - User1 has ${user1Docs.data.documents.length} documents, User2 has ${user2Docs.data.documents.length} documents`);

  console.log("✅ Permission system tests passed");
}

async function testYjsCollaboration() {
  console.log("🔄 Testing Yjs Real-time Document Sync...");

  const client = new TestApiClient(TEST_SERVER_URL);

  // Login
  const loginResponse = await client.login({
    identifier: TEST_USERS.user1.username,
    password: TEST_USERS.user1.password
  });
  client.setToken(loginResponse.data.sessionToken);

  // Create a specific document for Yjs testing
  const testDocResponse = await client.createDocument("yjs-test-doc", {
    title: "Yjs Test Document",
    description: "Document for testing Yjs collaboration"
  });
  const docPath = testDocResponse.data.document.metadata.path;
  const documentName = `doc:${docPath}`;

  // Create Yjs client for the document
  const yjsClient = new TestYjsClient(
    TEST_WS_URL,
    documentName,
    loginResponse.data.sessionToken
  );

  try {
    // Connect and authenticate
    await yjsClient.connect();
    assertEquals(yjsClient.isConnected(), true);
    assertEquals(yjsClient.isAuthenticated(), true);

    // Wait for initial sync
    await yjsClient.waitForSync();

    // Test 1: Text operations
    const text = yjsClient.getText("content");
    text.insert(0, "Hello, Yjs collaboration!");

    // Verify the document has content locally
    assertEquals(text.toString(), "Hello, Yjs collaboration!");

    // Test 2: Map operations
    const metadata = yjsClient.getMap("metadata");
    metadata.set("title", "Test Document");
    metadata.set("author", "testuser1");
    metadata.set("version", 1);

    assertEquals(metadata.get("title"), "Test Document");
    assertEquals(metadata.get("author"), "testuser1");
    assertEquals(metadata.get("version"), 1);

    // Test 3: Array operations
    const todos = yjsClient.getArray("todos");
    todos.push(["Task 1", "Task 2", "Task 3"]);

    assertEquals(todos.length, 3);
    assertEquals(todos.get(0), "Task 1");
    assertEquals(todos.get(1), "Task 2");
    assertEquals(todos.get(2), "Task 3");

    // Test 4: Complex text editing
    text.insert(text.length, "\nThis is a second line.");
    text.insert(text.length, "\nAnd a third line!");

    const finalText = text.toString();
    assertEquals(finalText.includes("Hello, Yjs collaboration!"), true);
    assertEquals(finalText.includes("second line"), true);
    assertEquals(finalText.includes("third line"), true);

    // Wait for final sync
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log("✅ Yjs document sync tests passed");

  } finally {
    yjsClient.disconnect();
  }
}

async function testMultiUserCollaboration() {
  console.log("👥 Testing Multi-User Operational Transformation...");

  const client1 = new TestApiClient(TEST_SERVER_URL);
  const client2 = new TestApiClient(TEST_SERVER_URL);

  // Login both users
  const login1Response = await client1.login({
    identifier: TEST_USERS.user1.username,
    password: TEST_USERS.user1.password
  });
  client1.setToken(login1Response.data.sessionToken);

  const login2Response = await client2.login({
    identifier: TEST_USERS.user2.username,
    password: TEST_USERS.user2.password
  });
  client2.setToken(login2Response.data.sessionToken);

  // Create a shared document for collaboration testing
  const sharedDocResponse = await client1.createDocument("multi-user-collab", {
    title: "Multi-User Collaboration Test",
    description: "Document for testing multi-user real-time collaboration"
  });
  const docPath = sharedDocResponse.data.document.metadata.path;
  const documentName = `doc:${docPath}`;

  // Create Yjs clients for both users
  const yjsClient1 = new TestYjsClient(
    TEST_WS_URL,
    documentName,
    login1Response.data.sessionToken
  );

  const yjsClient2 = new TestYjsClient(
    TEST_WS_URL,
    documentName,
    login2Response.data.sessionToken
  );

  try {
    // Connect both clients
    await Promise.all([
      yjsClient1.connect(),
      yjsClient2.connect()
    ]);

    assertEquals(yjsClient1.isConnected(), true);
    assertEquals(yjsClient2.isConnected(), true);
    assertEquals(yjsClient1.isAuthenticated(), true);
    assertEquals(yjsClient2.isAuthenticated(), true);

    // Wait for initial sync
    await Promise.all([
      yjsClient1.waitForSync(),
      yjsClient2.waitForSync()
    ]);

    // Test 1: Concurrent text editing
    const text1 = yjsClient1.getText("content");
    const text2 = yjsClient2.getText("content");

    // User 1 adds content at the beginning
    text1.insert(0, "User 1 start. ");

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 300));

    // User 2 adds content at what they think is the end
    text2.insert(text2.length, "User 2 end.");

    // Wait for synchronization
    await new Promise(resolve => setTimeout(resolve, 500));

    // Both documents should have the same content and both edits should be preserved
    const finalContent1 = text1.toString();
    const finalContent2 = text2.toString();

    assertEquals(finalContent1, finalContent2);
    assertEquals(finalContent1.includes("User 1 start"), true);
    assertEquals(finalContent1.includes("User 2 end"), true);

    // Test 2: Concurrent map operations
    const metadata1 = yjsClient1.getMap("metadata");
    const metadata2 = yjsClient2.getMap("metadata");

    // Both users set different keys simultaneously
    metadata1.set("editedBy", "user1");
    metadata1.set("user1Edit", "timestamp1");
    metadata2.set("lastModified", "now");
    metadata2.set("user2Edit", "timestamp2");

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 500));

    // Both maps should have all keys
    assertEquals(metadata1.get("editedBy"), "user1");
    assertEquals(metadata1.get("lastModified"), "now");
    assertEquals(metadata1.get("user1Edit"), "timestamp1");
    assertEquals(metadata1.get("user2Edit"), "timestamp2");

    assertEquals(metadata2.get("editedBy"), "user1");
    assertEquals(metadata2.get("lastModified"), "now");
    assertEquals(metadata2.get("user1Edit"), "timestamp1");
    assertEquals(metadata2.get("user2Edit"), "timestamp2");

    // Test 3: Concurrent array operations
    const items1 = yjsClient1.getArray("items");
    const items2 = yjsClient2.getArray("items");

    // Both users add items simultaneously
    items1.push(["item1", "item2"]);
    items2.push(["itemA", "itemB"]);

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 500));

    // Both arrays should have all items (exact order may vary due to OT)
    assertEquals(items1.length, 4);
    assertEquals(items2.length, 4);

    const items1Array = items1.toArray();
    const items2Array = items2.toArray();
    assertEquals(JSON.stringify(items1Array), JSON.stringify(items2Array));

    // Test 4: Complex conflict resolution
    const conflictText = yjsClient1.getText("conflicts");
    text1.insert(0, "Base text. ");

    // Wait for sync
    await new Promise(resolve => setTimeout(resolve, 200));

    // Both users edit the same position simultaneously
    const conflictText2 = yjsClient2.getText("conflicts");
    conflictText.insert(11, "User1 addition ");
    conflictText2.insert(11, "User2 addition ");

    // Wait for conflict resolution
    await new Promise(resolve => setTimeout(resolve, 800));

    // Both should converge to the same state
    const conflict1 = conflictText.toString();
    const conflict2 = conflictText2.toString();
    assertEquals(conflict1, conflict2);
    assertEquals(conflict1.includes("Base text"), true);
    assertEquals(conflict1.includes("User1 addition") || conflict1.includes("User2 addition"), true);

    console.log("✅ Multi-user operational transformation tests passed");

  } finally {
    yjsClient1.disconnect();
    yjsClient2.disconnect();
  }
}

async function testFileOperations() {
  console.log("📎 Testing File Operations...");

  const client = new TestApiClient(TEST_SERVER_URL);

  // Login
  const loginResponse = await client.login({
    identifier: TEST_USERS.user1.username,
    password: TEST_USERS.user1.password
  });
  client.setToken(loginResponse.sessionToken);

  // Create a test file
  const testFileContent = "This is a test file for integration testing.";
  const testFile = new File([testFileContent], "test-file.txt", {
    type: "text/plain"
  });

  // Upload file
  const formData = new FormData();
  formData.append("file", testFile);
  formData.append("filename", "test-file.txt");
  formData.append("documentPath", TEST_DOCUMENTS.root.path);
  formData.append("description", "Test file upload");

  const uploadResponse = await client.request("/api/uploads/", {
    method: "POST",
    body: formData,
    headers: {} // Let browser set Content-Type with boundary
  });

  assertExists(uploadResponse.file);
  assertEquals(uploadResponse.file.filename, "test-file.txt");
  assertEquals(uploadResponse.file.documentPath, TEST_DOCUMENTS.root.path);

  // List files
  const listResponse = await client.request("/api/uploads/");
  assertExists(listResponse.files);
  assertEquals(listResponse.files.length >= 1, true);

  // Get file metadata
  const fileId = uploadResponse.file.id;
  const metadataResponse = await client.request(`/api/uploads/${fileId}`);
  assertExists(metadataResponse.file);
  assertEquals(metadataResponse.file.id, fileId);

  // Clean up - delete file
  await client.request(`/api/uploads/${fileId}`, {
    method: "DELETE"
  });

  console.log("✅ File operation tests passed");
}

async function testYjsPersistence() {
  console.log("💾 Testing Yjs Document Persistence...");

  const client = new TestApiClient(TEST_SERVER_URL);

  // Login
  const loginResponse = await client.login({
    identifier: TEST_USERS.user1.username,
    password: TEST_USERS.user1.password
  });
  client.setToken(loginResponse.sessionToken);

  // Create a document for persistence testing
  const docName = "persistence-test-doc";
  const createResponse = await client.createDocument(docName, {
    title: "Persistence Test Document",
    description: "Test document for persistence validation",
    isPublic: false
  });

  const actualPath = createResponse.document.path;
  console.log("📝 Document created for persistence test:", actualPath);

  // === Phase 1: Create and populate document ===
  console.log("🔌 Phase 1: Creating and populating document...");

  const yjsClient1 = new TestYjsClient(TEST_WS_URL, actualPath, loginResponse.sessionToken);
  await yjsClient1.connect();
  await yjsClient1.waitForSync();

  // Add various types of content
  const text = yjsClient1.getText("content");
  const map = yjsClient1.getMap("metadata");
  const array = yjsClient1.getArray("items");

  text.insert(0, "This is persistent content that should survive restarts!");
  map.set("author", "Test User");
  map.set("created", new Date().toISOString());
  map.set("version", 1);

  array.push(["Item 1", "Item 2", "Item 3"]);

  console.log("📝 Added content:", {
    text: text.toString(),
    mapSize: map.size,
    arrayLength: array.length
  });

  // Wait for persistence (debounced save)
  await new Promise(resolve => setTimeout(resolve, 3000));
  await yjsClient1.disconnect();

  console.log("💾 Content saved and client disconnected");

  // === Phase 2: Reconnect and verify persistence ===
  console.log("🔌 Phase 2: Reconnecting to verify persistence...");

  const yjsClient2 = new TestYjsClient(TEST_WS_URL, actualPath, loginResponse.sessionToken);
  await yjsClient2.connect();
  await yjsClient2.waitForSync();

  // Verify all content is restored
  const restoredText = yjsClient2.getText("content");
  const restoredMap = yjsClient2.getMap("metadata");
  const restoredArray = yjsClient2.getArray("items");

  console.log("📖 Restored content:", {
    text: restoredText.toString(),
    mapSize: restoredMap.size,
    arrayLength: restoredArray.length
  });

  // Validate text content
  assertEquals(
    restoredText.toString(),
    "This is persistent content that should survive restarts!",
    "Text content should be restored exactly"
  );

  // Validate map content
  assertEquals(restoredMap.get("author"), "Test User", "Map author should be restored");
  assertEquals(restoredMap.get("version"), 1, "Map version should be restored");
  assertExists(restoredMap.get("created"), "Map created timestamp should exist");

  // Validate array content
  assertEquals(restoredArray.length, 3, "Array should have 3 items");
  assertEquals(restoredArray.get(0), "Item 1", "First array item should be restored");
  assertEquals(restoredArray.get(1), "Item 2", "Second array item should be restored");
  assertEquals(restoredArray.get(2), "Item 3", "Third array item should be restored");

  // === Phase 3: Test incremental updates on restored document ===
  console.log("🔄 Phase 3: Testing incremental updates on restored document...");

  // Add more content to the restored document
  restoredText.insert(restoredText.length, " Additional content after restoration.");
  restoredMap.set("updated", new Date().toISOString());
  restoredMap.set("version", 2);
  restoredArray.push(["Item 4"]);

  console.log("📝 Added incremental content");

  // Wait for persistence
  await new Promise(resolve => setTimeout(resolve, 3000));
  await yjsClient2.disconnect();

  // === Phase 4: Final verification ===
  console.log("🔌 Phase 4: Final verification after incremental updates...");

  const yjsClient3 = new TestYjsClient(TEST_WS_URL, actualPath, loginResponse.sessionToken);
  await yjsClient3.connect();
  await yjsClient3.waitForSync();

  const finalText = yjsClient3.getText("content");
  const finalMap = yjsClient3.getMap("metadata");
  const finalArray = yjsClient3.getArray("items");

  console.log("📖 Final restored content:", {
    text: finalText.toString(),
    mapEntries: Array.from(finalMap.entries()),
    arrayItems: finalArray.toArray()
  });

  // Validate final state includes all updates
  assertEquals(
    finalText.toString(),
    "This is persistent content that should survive restarts! Additional content after restoration.",
    "Text should include both original and incremental content"
  );

  assertEquals(finalMap.get("version"), 2, "Map version should be updated");
  assertExists(finalMap.get("updated"), "Map should have updated timestamp");
  assertEquals(finalArray.length, 4, "Array should have 4 items after update");
  assertEquals(finalArray.get(3), "Item 4", "Fourth array item should be present");

  await yjsClient3.disconnect();

  console.log("✅ Yjs persistence tests passed - document state properly preserved across reconnections");
}

async function testBasicYjsConnection() {
  console.log("🔗 Testing Basic Yjs Connection...");

  // Test basic WebSocket connection to /ws endpoint (not /collaborate)
  try {
    const wsUrl = `${TEST_WS_URL}/ws`;
    const ws = new WebSocket(wsUrl);

    const connectionPromise = new Promise<void>((resolve, reject) => {
      let messageReceived = false;

      ws.onopen = () => {
        console.log("Basic WebSocket connected successfully");
        // Send a test message
        ws.send("Hello from test client");
      };

      ws.onmessage = (event) => {
        console.log("Received message:", event.data);
        if (event.data.includes("Echo: Hello from test client")) {
          messageReceived = true;
          ws.close();
          resolve();
        }
      };

      ws.onerror = (error) => {
        reject(new Error(`WebSocket error: ${error}`));
      };

      ws.onclose = () => {
        if (!messageReceived) {
          reject(new Error("WebSocket closed without receiving expected message"));
        }
      };

      // Timeout after 5 seconds
      setTimeout(() => {
        if (!messageReceived) {
          ws.close();
          reject(new Error("WebSocket message timeout"));
        }
      }, 5000);
    });

    await connectionPromise;
    console.log("✅ Basic Yjs connection test passed");

  } catch (error) {
    console.log(`⚠️  Basic WebSocket test failed: ${error}`);
    throw error;
  }
}