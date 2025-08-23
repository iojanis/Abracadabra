# Abracadabra Client

A comprehensive JavaScript/TypeScript client library for the Abracadabra collaborative document platform. This client provides a complete solution for real-time document collaboration with offline-first capabilities, authentication, file uploads, and much more.

## 🎩 Features

### Core Collaboration
- **Real-time Collaboration:** Multiple users can edit documents simultaneously with conflict-free merging
- **Offline-first:** Documents are stored locally using IndexedDB for seamless offline editing
- **Automatic Sync:** Changes are synchronized automatically when connection is restored
- **Conflict Resolution:** Built-in CRDT (Conflict-free Replicated Data Types) using Yjs

### Authentication & User Management
- **User Registration & Login:** Full authentication system with JWT tokens
- **Profile Management:** Update user profiles and settings
- **Persistent Sessions:** Automatic token storage and session restoration
- **Password Management:** Change passwords securely

### Document Management
- **CRUD Operations:** Create, read, update, and delete documents
- **Hierarchical Organization:** Support for nested document structures
- **Search:** Full-text search across documents
- **Permissions:** Fine-grained access control (public/private documents)
- **Metadata:** Document titles, descriptions, tags, and timestamps

### File Management
- **File Uploads:** Upload images, documents, and other attachments
- **File Organization:** Link files to specific documents
- **File Metadata:** Descriptions, tags, and file information
- **File Management:** List and delete uploaded files

### Advanced Features
- **Event System:** Listen to authentication, connection, and document events
- **Network Monitoring:** Detect online/offline status
- **Connection Status:** Monitor server, P2P, and local storage connections
- **Auto-reconnection:** Automatic reconnection with exponential backoff
- **Admin Features:** System statistics and user management (for admin users)

## 📦 Installation

```bash
npm install @abracadabra/client yjs y-indexeddb y-webrtc @hocuspocus/provider
```

## 🚀 Quick Start

### Basic Setup

```typescript
import { AbracadabraClient } from '@abracadabra/client';
import * as Y from 'yjs';

// Initialize the client
const client = new AbracadabraClient({
  serverUrl: 'http://localhost:8787',
  hocuspocusUrl: 'ws://localhost:8787/collaborate',
  roomName: 'my-workspace',
  enableOffline: true,
  enableWebRTC: false, // Optional P2P collaboration
  autoReconnect: true,
});

// Connect to the server
await client.connect();
```

### Authentication

```typescript
// Register a new user
try {
  const { user, token } = await client.register({
    username: 'alice',
    email: 'alice@example.com',
    password: 'secure-password',
    displayName: 'Alice Cooper'
  });
  console.log('Registration successful:', user);
} catch (error) {
  console.error('Registration failed:', error.message);
}

// Login with existing credentials
try {
  const { user, token } = await client.login({
    identifier: 'alice', // username or email
    password: 'secure-password'
  });
  console.log('Login successful:', user);
} catch (error) {
  console.error('Login failed:', error.message);
}

// Check authentication status
if (client.isAuthenticated()) {
  const user = client.getCurrentUser();
  console.log('Current user:', user);
}

// Logout
await client.logout();
```

### Document Management

```typescript
// Create a new document
const document = await client.createDocument('projects/my-project.md', {
  title: 'My Project',
  description: 'A collaborative project document',
  initialContent: '# My Project\n\nStart writing here...',
  isPublic: false
});

// Fetch document list
const documents = await client.fetchIndex();
console.log('Available documents:', documents);

// Load a document for editing
const doc = await client.getDocument('projects/my-project.md');
const ytext = doc.getText('content');

// Listen for changes
ytext.observe(() => {
  console.log('Document content:', ytext.toString());
});

// Make changes
ytext.insert(0, 'Hello, World!\n');

// Search documents
const searchResults = await client.searchDocuments('project', {
  limit: 10,
  onlyPublic: false
});

// Update document metadata
const updatedDoc = await client.updateDocument('projects/my-project.md', {
  title: 'Updated Project Title',
  tags: ['important', 'work']
});

// Delete a document
await client.deleteDocument('old-document.md');
```

### File Uploads

```typescript
// Upload a file
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const file = fileInput.files[0];

const fileMetadata = await client.uploadFile(file, {
  description: 'Project screenshot',
  tags: ['screenshot', 'ui'],
  documentPath: 'projects/my-project.md' // Associate with document
});

// List uploaded files
const files = await client.listFiles({
  limit: 20,
  documentPath: 'projects/my-project.md'
});

// Delete a file
await client.deleteFile(fileMetadata.id);
```

### Event Handling

```typescript
// Authentication events
client.on('auth:login', (user) => {
  console.log('User logged in:', user.displayName);
});

client.on('auth:logout', () => {
  console.log('User logged out');
});

// Connection events
client.on('connection:open', () => {
  console.log('Connected to server');
});

client.on('connection:close', () => {
  console.log('Disconnected from server');
});

// Document events
client.on('document:loaded', (path, doc) => {
  console.log('Document loaded:', path);
});

// Network events
client.on('online', () => {
  console.log('Network back online');
});

client.on('offline', () => {
  console.log('Network went offline');
});
```

## 📚 API Reference

### Constructor

#### `new AbracadabraClient(config: AbracadabraClientConfig)`

Creates a new client instance.

**Config Options:**
```typescript
interface AbracadabraClientConfig {
  serverUrl: string;           // HTTP server URL (e.g., 'http://localhost:8787')
  hocuspocusUrl: string;       // WebSocket URL (e.g., 'ws://localhost:8787/collaborate')
  roomName: string;            // Collaboration room name
  token?: string;              // JWT token (optional, managed automatically)
  enableOffline?: boolean;     // Enable offline persistence (default: true)
  enableWebRTC?: boolean;      // Enable P2P collaboration (default: false)
  autoReconnect?: boolean;     // Auto-reconnect on disconnect (default: true)
}
```

### Connection Management

#### `connect(): Promise<void>`
Connect to all providers (server, offline storage, P2P).

#### `disconnect(): void`
Disconnect from all providers.

#### `destroy(): void`
Destroy the client and clean up all resources.

#### `getConnectionStatus(): ConnectionStatus`
Get current connection status for all providers.

#### `isOnlineStatus(): boolean`
Check if the client is currently online.

### Authentication Methods

#### `register(userData: RegisterData): Promise<{user: AuthUser, token: string}>`
Register a new user account.

#### `login(credentials: LoginData): Promise<{user: AuthUser, token: string}>`
Login with username/email and password.

#### `logout(): Promise<void>`
Logout and clear the session.

#### `getCurrentUser(): AuthUser | null`
Get the currently authenticated user.

#### `isAuthenticated(): boolean`
Check if a user is currently authenticated.

#### `getUserProfile(): Promise<AuthUser>`
Fetch the current user's profile from the server.

#### `updateProfile(updates: ProfileUpdates): Promise<AuthUser>`
Update user profile information.

#### `changePassword(oldPassword: string, newPassword: string): Promise<void>`
Change the user's password.

### Document Management

#### `fetchIndex(): Promise<DocumentMetadata[]>`
Fetch the list of available documents from the server.

#### `getDocument(path: string): Promise<Y.Doc>`
Load a document for editing. Returns a Yjs document.

#### `createDocument(path: string, options?: CreateOptions): Promise<DocumentMetadata>`
Create a new document.

#### `updateDocument(path: string, updates: UpdateOptions): Promise<DocumentMetadata>`
Update document metadata.

#### `deleteDocument(path: string): Promise<void>`
Delete a document.

#### `searchDocuments(query: string, options?: SearchOptions): Promise<DocumentMetadata[]>`
Search documents by content and metadata.

#### `leaveDocument(path: string): void`
Unload a document and free up resources.

#### `getDocumentIndex(): Y.Map<DocumentMetadata>`
Get the collaborative document index (Yjs Map).

### File Management

#### `uploadFile(file: File, options?: UploadOptions): Promise<FileMetadata>`
Upload a file to the server.

#### `listFiles(options?: ListOptions): Promise<FileMetadata[]>`
List uploaded files.

#### `deleteFile(fileId: string): Promise<void>`
Delete an uploaded file.

### Admin Methods

#### `listUsers(options?: ListUsersOptions): Promise<AuthUser[]>`
List all users (admin only).

#### `getSystemStats(): Promise<SystemStats>`
Get system statistics (admin only).

### Event System

The client emits various events that you can listen to:

```typescript
// Event types
interface ClientEvents {
  'auth:login': (user: AuthUser) => void;
  'auth:logout': () => void;
  'auth:error': (error: Error) => void;
  'connection:open': () => void;
  'connection:close': () => void;
  'connection:error': (error: Error) => void;
  'document:loaded': (path: string, doc: Y.Doc) => void;
  'document:error': (path: string, error: Error) => void;
  'sync:start': () => void;
  'sync:complete': () => void;
  'online': () => void;
  'offline': () => void;
}

// Usage
client.on('auth:login', (user) => {
  // Handle user login
});

client.off('auth:login', handler); // Remove listener
```

## 🔧 Development Setup

### Running the Example

1. Start the Abracadabra server:
   ```bash
   cd abracadabra-server
   deno run --allow-all src/main.ts
   ```

2. Create test users and documents:
   ```bash
   ./scripts/setup-dev-data.sh
   ```

3. Open the client example:
   ```bash
   cd packages/client/examples
   # Serve the files (use any static file server)
   python -m http.server 8080
   # Or with Node.js
   npx serve .
   ```

4. Open http://localhost:8080 in your browser

### Test Users

The setup script creates these test users:

- **admin** / admin123 (Administrator)
- **alice** / alice123 (Editor)
- **bob** / bob123 (Editor)
- **charlie** / charlie123 (User)
- **demo** / demo123 (User)

## 🏗️ Architecture

The Abracadabra client uses a multi-layered architecture:

1. **Application Layer:** Your application code
2. **Client API:** High-level methods for documents, auth, etc.
3. **Yjs Integration:** Real-time collaboration and CRDT
4. **Provider Layer:** IndexedDB, WebSocket, and WebRTC providers
5. **Storage Layer:** Browser IndexedDB and server storage

### Data Flow

```
User Input → Client API → Yjs Document → Providers → Storage/Network
     ↑                                                        ↓
UI Updates ← Event System ← Change Detection ← Sync ← Server/Peers
```

## 🔒 Security

- JWT tokens are stored securely in localStorage
- All API requests include proper authentication headers
- File uploads are validated server-side
- Document permissions are enforced at the server level

## 🌐 Browser Support

- Chrome 89+
- Firefox 87+
- Safari 14+
- Edge 89+

Requires support for:
- IndexedDB
- WebSockets
- WebRTC (optional)
- ES2020 features

## 📄 License

MIT License. See LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📞 Support

For issues and questions:

- Open an issue on GitHub
- Check the documentation
- Review the example implementation

## 🚀 Roadmap

- [ ] React/Vue/Svelte integrations
- [ ] Mobile SDK (React Native)
- [ ] Enhanced offline capabilities
- [ ] Plugin system
- [ ] Rich text editing components
- [ ] Real-time cursors and selections
- [ ] Voice/video collaboration