# 🪄 Abracadabra Client

A comprehensive JavaScript/TypeScript client library for the Abracadabra collaborative document platform. This client provides a complete solution for real-time document collaboration with offline-first capabilities, authentication, file uploads, and much more.

## ✨ Features

### Core Collaboration
- **Real-time Collaboration:** Multiple users can edit documents simultaneously with conflict-free merging using [Yjs](https://github.com/yjs/yjs).
- **Offline-first:** Documents are stored locally using IndexedDB for seamless offline editing.
- **Automatic Sync:** Changes are synchronized automatically when the connection is restored.
- **Conflict Resolution:** Built-in CRDT (Conflict-free Replicated Data Types) for robust conflict resolution.

### Authentication & User Management
- **User Registration & Login:** Full authentication system with JWT tokens.
- **Profile Management:** Update user profiles and settings.
- **Persistent Sessions:** Automatic token storage and session restoration.
- **Password Management:** Change passwords securely.

### Document Management
- **CRUD Operations:** Create, read, update, and delete documents.
- **Hierarchical Organization:** Support for nested document structures.
- **Search:** Full-text search across documents.
- **Permissions:** Fine-grained access control (public/private documents).
- **Metadata:** Document titles, descriptions, tags, and timestamps.

### File Management
- **File Uploads:** Upload images, documents, and other attachments.
- **File Organization:** Link files to specific documents.
- **File Metadata:** Descriptions, tags, and file information.
- **File Management:** List and delete uploaded files.

### Advanced Features
- **Event System:** Listen to authentication, connection, and document events.
- **Network Monitoring:** Detect online/offline status.
- **Connection Status:** Monitor server, P2P, and local storage connections.
- **Auto-reconnection:** Automatic reconnection with exponential backoff.
- **Admin Features:** System statistics and user management (for admin users).

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

### Nuxt.js Integration

This package includes a Nuxt.js plugin and composables for easy integration into your Nuxt.js application.

1.  **Enable the plugin:**

    Create a file `plugins/abracadabra.ts` with the following content:

    ```typescript
    import { defineNuxtPlugin } from '#app';
    import { AbracadabraClient } from '@abracadabra/client';

    export default defineNuxtPlugin(async (nuxtApp) => {
      const client = new AbracadabraClient({
        serverUrl: 'http://localhost:8787',
        hocuspocusUrl: 'ws://localhost:8787/collaborate',
        roomName: 'my-workspace',
      });

      await client.connect();

      return {
        provide: {
          abracadabra: client,
        },
      };
    });
    ```

2.  **Use the composables:**

    You can now use the `$abracadabra` instance in your components and pages.

    ```vue
    <template>
      <div>
        <p>User: {{ user?.displayName }}</p>
        <button @click="logout">Logout</button>
      </div>
    </template>

    <script setup>
    import { useNuxtApp } from '#app';

    const { $abracadabra } = useNuxtApp();
    const user = $abracadabra.getCurrentUser();

    const logout = async () => {
      await $abracadabra.logout();
    };
    </script>
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

- `connect(): Promise<void>`: Connect to all providers (server, offline storage, P2P).
- `disconnect(): void`: Disconnect from all providers.
- `destroy(): void`: Destroy the client and clean up all resources.
- `getConnectionStatus(): ConnectionStatus`: Get current connection status for all providers.
- `isOnlineStatus(): boolean`: Check if the client is currently online.

### Authentication Methods

- `register(userData: RegisterData): Promise<{user: AuthUser, token: string}>`: Register a new user account.
- `login(credentials: LoginData): Promise<{user: AuthUser, token: string}>`: Login with username/email and password.
- `logout(): Promise<void>`: Logout and clear the session.
- `getCurrentUser(): AuthUser | null`: Get the currently authenticated user.
- `isAuthenticated(): boolean`: Check if a user is currently authenticated.
- `getUserProfile(): Promise<AuthUser>`: Fetch the current user's profile from the server.
- `updateProfile(updates: ProfileUpdates): Promise<AuthUser>`: Update user profile information.
- `changePassword(oldPassword: string, newPassword: string): Promise<void>`: Change the user's password.

### Document Management

- `fetchIndex(): Promise<DocumentMetadata[]>`: Fetch the list of available documents from the server.
- `getDocument(path: string): Promise<Y.Doc>`: Load a document for editing. Returns a Yjs document.
- `createDocument(path: string, options?: CreateOptions): Promise<DocumentMetadata>`: Create a new document.
- `updateDocument(path: string, updates: UpdateOptions): Promise<DocumentMetadata>`: Update document metadata.
- `deleteDocument(path: string): Promise<void>`: Delete a document.
- `searchDocuments(query: string, options?: SearchOptions): Promise<DocumentMetadata[]>`: Search documents by content and metadata.
- `leaveDocument(path: string): void`: Unload a document and free up resources.
- `getDocumentIndex(): Y.Map<DocumentMetadata>`: Get the collaborative document index (Yjs Map).

### File Management

- `uploadFile(file: File, options?: UploadOptions): Promise<FileMetadata>`: Upload a file to the server.
- `listFiles(options?: ListOptions): Promise<FileMetadata[]>`: List uploaded files.
- `deleteFile(fileId: string): Promise<void>`: Delete an uploaded file.

### Admin Methods

- `listUsers(options?: ListUsersOptions): Promise<AuthUser[]>`: List all users (admin only).
- `getSystemStats(): Promise<SystemStats>`: Get system statistics (admin only).

### Event System

The client emits various events that you can listen to:

- `auth:login`: Fired when a user successfully logs in.
- `auth:logout`: Fired when a user logs out.
- `connection:open`: Fired when the WebSocket connection to the server is established.
- `connection:close`: Fired when the WebSocket connection is closed.
- `document:loaded`: Fired when a document is loaded and synced.
- `message`: Fired when a general-purpose message is received from the server.
- `online`: Fired when the client comes back online.
- `offline`: Fired when the client loses its internet connection.

### Bi-directional Communication

The client supports sending and receiving general-purpose messages to and from the server over the main WebSocket connection.

**Sending Messages to the Server**

Use the `sendMessage` method to send a message to the server. The server can listen for these messages using the `onStateless` hook.

```typescript
client.sendMessage('my-custom-action', { foo: 'bar' });
```

**Receiving Messages from the Server**

Listen for the `message` event to handle incoming messages from the server.

```typescript
client.on('message', (data) => {
  console.log('Received message from server:', data);

  if (data.type === 'notification') {
    // Display a notification to the user
    alert(data.payload.message);
  }
});
```

## 📚 API Reference

### Running the Example

1.  **Start the Abracadabra server:**
    ```bash
    cd abracadabra-server
    deno task dev
    ```

2.  **Create test users and documents:**
    ```bash
    ./scripts/setup-dev-data.sh
    ```

3.  **Open the client example:**
    ```bash
    cd packages/client/examples
    # Serve the files (use any static file server)
    npx serve .
    ```

4.  Open `http://localhost:3000` in your browser.

### Test Users

The setup script creates these test users:

-   **admin** / admin123 (Administrator)
-   **alice** / alice123 (Editor)
-   **bob** / bob123 (Editor)
-   **charlie** / charlie123 (User)
-   **demo** / demo123 (User)

## 🏗️ Architecture

The Abracadabra client uses a multi-layered architecture:

1.  **Application Layer:** Your application code
2.  **Client API:** High-level methods for documents, auth, etc.
3.  **Yjs Integration:** Real-time collaboration and CRDT
4.  **Provider Layer:** IndexedDB, WebSocket, and WebRTC providers
5.  **Storage Layer:** Browser IndexedDB and server storage

## 🔒 Security

-   JWT tokens are stored securely in localStorage.
-   All API requests include proper authentication headers.
-   File uploads are validated server-side.
-   Document permissions are enforced at the server level.

## 🌐 Browser Support

-   Chrome 89+
-   Firefox 87+
-   Safari 14+
-   Edge 89+

Requires support for:
-   IndexedDB
-   WebSockets
-   WebRTC (optional)
-   ES2020 features

## 📄 License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
