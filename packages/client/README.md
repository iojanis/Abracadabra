# Abracadabra Client

A client-side library for interacting with the Abracadabra collaborative document server.

This library provides an offline-first experience for real-time collaboration using Yjs. It combines `y-indexeddb` for local persistence, `y-webrtc` for peer-to-peer communication, and `@hocuspocus/provider` for client-server synchronization.

## Features

- **Offline-first:** Your data is stored locally in IndexedDB, so your application works even without a network connection.
- **Real-time Collaboration:** Changes are synced seamlessly between users in real-time.
- **Hierarchical Documents:** Uses Yjs subdocuments to manage complex document structures.
- **Provider Agnostic:** Automatically manages multiple Yjs providers.
- **Server-Driven Index:** Fetches a list of documents from the Abracadabra server's REST API.

## Installation

```bash
npm install @abracadabra/client yjs
```
*(Note: At the time of writing, there were environment issues preventing `npm install` from running in the development environment.)*

## Usage

Here's a basic example of how to use the `AbracadabraClient`:

```typescript
import { AbracadabraClient } from '@abracadabra/client';
import * as Y from 'yjs';

// 1. Configure the client
const client = new AbracadabraClient({
  serverUrl: 'http://localhost:8787',
  hocuspocusUrl: 'ws://localhost:8787',
  roomName: 'my-abracadabra-room',
  token: 'your-jwt-token', // Required for fetching the index and authentication
});

// 2. Connect to the providers
client.connect();

// 3. Fetch the document index from the server
async function initialize() {
  try {
    await client.fetchIndex();
    console.log('Document index loaded.');
  } catch (error) {
    console.error('Failed to load document index:', error);
  }
}

initialize();

// 4. Get the document index (a Y.Map) and listen for changes
const documentIndex = client.getDocumentIndex();
documentIndex.observeDeep(() => {
  console.log('Document index changed:', documentIndex.toJSON());
});

// 5. Load a subdocument
async function openDocument(name: string) {
  try {
    const doc = await client.getDocument(name);
    console.log(`Successfully loaded subdocument: ${name}`);

    // You can now use the Y.Doc instance
    const ytext = doc.getText('content');
    ytext.insert(0, 'Hello, World!');

    console.log(ytext.toString());

  } catch (error) {
    console.error(`Failed to open document: ${name}`, error);
  }
}

// Example of opening a document named 'my-doc'
openDocument('my-doc');


// 6. Clean up when you're done
// window.addEventListener('beforeunload', () => {
//   client.destroy();
// });
```

## API

### `new AbracadabraClient(config)`

Creates a new client instance.

**Config:**
- `serverUrl` (string): URL of the Abracadabra REST API server.
- `hocuspocusUrl` (string): URL of the Hocuspocus WebSocket server.
- `roomName` (string): A name for the collaboration room.
- `token` (string, optional): A JWT for authentication.

### `client.connect()`

Connects to the configured providers.

### `client.disconnect()`

Disconnects from the providers.

### `client.destroy()`

Destroys the client, disconnects from providers, and cleans up all data.

### `client.fetchIndex(): Promise<void>`

Fetches the document list from the server and populates the index.

### `client.getDocumentIndex(): Y.Map<any>`

Returns the document index, which is a `Y.Map`.

### `client.getDocument(name: string): Promise<Y.Doc>`

Loads a subdocument. Returns a promise that resolves with the `Y.Doc` instance for the subdocument.

### `client.leaveDocument(name: string)`

Unloads a subdocument from memory.
