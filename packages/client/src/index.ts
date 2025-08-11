import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebrtcProvider } from 'y-webrtc';
import { HocuspocusProvider } from '@hocuspocus/provider';

/**
 * Configuration options for the AbracadabraClient.
 */
export interface AbracadabraClientConfig {
  /**
   * The URL of the Hocuspocus WebSocket server.
   * e.g. 'ws://localhost:8787'
   */
  hocuspocusUrl: string;

  /**
   * The URL of the Abracadabra REST API server.
   * e.g. 'http://localhost:8787'
   */
  serverUrl: string;

  /**
   * The name of the room or document. This is used for all providers.
   */
  roomName: string;

  /**
   * A JWT token for authentication.
   */
  token?: string;
}

/**
 * The main client for interacting with the Abracadabra server.
 */
export class AbracadabraClient {
  public doc: Y.Doc;
  private config: AbracadabraClientConfig;

  private indexeddb: IndexeddbPersistence;
  private webrtc: WebrtcProvider | null = null;
  private hocuspocus: HocuspocusProvider;

  private subdocs = new Map<string, Y.Doc>();
  private documents: Y.Map<Y.Doc>;
  private documentIndex: Y.Map<any>;

  constructor(config: AbracadabraClientConfig) {
    this.config = config;
    this.doc = new Y.Doc();
    this.documents = this.doc.getMap('documents');
    this.documentIndex = this.doc.getMap('documentIndex');

    // Set up the providers
    this.indexeddb = new IndexeddbPersistence(this.config.roomName, this.doc);

    // Hocuspocus provider for client-server sync
    this.hocuspocus = new HocuspocusProvider({
      url: this.config.hocuspocusUrl,
      name: this.config.roomName,
      document: this.doc,
      token: this.config.token,
    });

    // WebRTC provider for peer-to-peer sync
    // Only initialize in browser environments
    if (typeof window !== 'undefined') {
      this.webrtc = new WebrtcProvider(this.config.roomName, this.doc);
    }
  }

  /**
   * Connects to the providers.
   * Note: The providers connect automatically on instantiation.
   * This method is for explicitly managing connection status if needed in the future.
   */
  public connect() {
    this.hocuspocus.connect();
    this.webrtc?.connect();
  }

  /**
   * Disconnects from all providers.
   */
  public disconnect() {
    this.hocuspocus.disconnect();
    this.webrtc?.disconnect();
    this.indexeddb.destroy();
  }

  /**
   * Destroys the client and all associated providers and data.
   */
  public destroy() {
    this.disconnect();
    this.subdocs.forEach((doc) => doc.destroy());
    this.doc.destroy();
  }

  /**
   * Gets a Y.Doc for a subdocument.
   *
   * @param name The name of the subdocument.
   * @returns A promise that resolves with the Y.Doc for the subdocument.
   */
  public async getDocument(name: string): Promise<Y.Doc> {
    const cachedDoc = this.subdocs.get(name);
    if (cachedDoc) {
      return cachedDoc;
    }

    let subdoc = this.documents.get(name);
    if (!subdoc) {
      subdoc = new Y.Doc({ guid: name });
      this.documents.set(name, subdoc);
    }

    // Load the subdocument. The Hocuspocus provider will fetch the data.
    subdoc.load();
    this.hocuspocus.fetchSubdocument(subdoc);

    // Wait for the subdocument to be synced
    await new Promise<void>((resolve) => {
      const onSynced = (data: { document: Y.Doc }) => {
        if (data.document === subdoc) {
          this.hocuspocus.off('synced', onSynced);
          resolve();
        }
      };
      this.hocuspocus.on('synced', onSynced);
    });

    this.subdocs.set(name, subdoc);
    return subdoc;
  }

  /**
   * Leaves a subdocument, destroying its Y.Doc and removing it from the cache.
   *
   * @param name The name of the subdocument to leave.
   */
  public leaveDocument(name:string) {
    const subdoc = this.subdocs.get(name);
    if (subdoc) {
      subdoc.destroy();
      this.subdocs.delete(name);
    }
  }

  /**
   * Fetches the list of documents from the server and populates the document index.
   */
  public async fetchIndex() {
    if (!this.config.token) {
      throw new Error('Authentication token is required to fetch the document index.');
    }

    const url = `${this.config.serverUrl}/api/documents/`;
    const headers: HeadersInit = {
      'Authorization': `Bearer ${this.config.token}`,
    };

    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch document index: ${response.statusText}`);
      }

      const result = await response.json();
      const documents = result.data.documents;

      if (!Array.isArray(documents)) {
        throw new Error('Invalid response format from server.');
      }

      // Using a transaction to batch updates to the Y.Map
      this.doc.transact(() => {
        documents.forEach((doc: any) => {
          if (doc.path) {
            this.documentIndex.set(doc.path, doc);
          }
        });
      });

    } catch (error) {
      console.error('Error fetching document index:', error);
      throw error;
    }
  }

  /**
   * Returns the document index as a Y.Map.
   * The map is a collaborative data structure and can be observed for changes.
   * @returns The Y.Map instance representing the document index.
   */
  public getDocumentIndex(): Y.Map<any> {
    return this.documentIndex;
  }
}
