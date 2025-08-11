import * as Y from 'yjs';
import { AbracadabraClient } from '../src/index';

const MOCK_TOKEN = 'this-is-a-mock-jwt-token';
const ROOM_NAME = 'abracadabra-example-room';

// --- UI Elements ---
const fetchIndexBtn = document.getElementById('fetch-index') as HTMLButtonElement;
const docList = document.getElementById('doc-list') as HTMLUListElement;
const currentDocTitle = document.getElementById('current-doc-title') as HTMLHeadingElement;
const docContent = document.getElementById('doc-content') as HTMLTextAreaElement;

// --- Abracadabra Client Setup ---
const client = new AbracadabraClient({
  serverUrl: 'http://localhost:8787',
  hocuspocusUrl: 'ws://localhost:8787',
  roomName: ROOM_NAME,
  token: MOCK_TOKEN,
});

client.connect();

// --- State ---
let activeDocName: string | null = null;
let ytext: Y.Text | null = null;

// --- Functions ---

/**
 * Renders the document list from the client's index.
 */
function renderDocumentList() {
  docList.innerHTML = '';
  const documentIndex = client.getDocumentIndex();

  documentIndex.forEach((doc, name) => {
    const li = document.createElement('li');
    li.textContent = doc.title || name;
    li.dataset.docName = name;
    if (name === activeDocName) {
      li.classList.add('active');
    }
    docList.appendChild(li);
  });
}

/**
 * Loads a document and binds it to the textarea.
 * @param name The name of the document to load.
 */
async function loadDocument(name: string) {
  if (activeDocName) {
    client.leaveDocument(activeDocName);
  }

  activeDocName = name;
  currentDocTitle.textContent = `Editing: ${name}`;
  docContent.disabled = false;
  docContent.value = '';

  try {
    const subdoc = await client.getDocument(name);
    ytext = subdoc.getText('content');

    // Bind Y.Text to the textarea
    ytext.observe(() => {
      docContent.value = ytext!.toString();
    });

    docContent.oninput = () => {
      // This is a simple implementation. For a real editor,
      // you would calculate the diff and apply it.
      subdoc.transact(() => {
        if(ytext) {
            ytext.delete(0, ytext.length);
            ytext.insert(0, docContent.value);
        }
      });
    };

    docContent.value = ytext.toString();

  } catch (error) {
    console.error(`Failed to load document: ${name}`, error);
    alert(`Failed to load document: ${name}`);
  }

  renderDocumentList();
}

// --- Event Listeners ---

fetchIndexBtn.addEventListener('click', async () => {
  try {
    await client.fetchIndex();
    alert('Document index fetched successfully!');
  } catch (error) {
    console.error('Failed to fetch index:', error);
    alert('Failed to fetch index. Make sure the server is running and check the console.');
  }
});

docList.addEventListener('click', (event) => {
  const target = event.target as HTMLLIElement;
  if (target.tagName === 'LI' && target.dataset.docName) {
    loadDocument(target.dataset.docName);
  }
});

// --- Initial Setup ---

// Observe the document index for changes and re-render the list
client.getDocumentIndex().observeDeep(() => {
  renderDocumentList();
});

// Clean up on page leave
window.addEventListener('beforeunload', () => {
  client.destroy();
});

console.log('Abracadabra Client Example initialized.');
console.log('1. Make sure the Abracadabra server is running.');
console.log('2. Click "Fetch Index" to get the list of documents.');
console.log('3. Click on a document to start editing.');
