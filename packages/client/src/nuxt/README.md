# Nuxt Integration for Abracadabra Client

This directory contains the complete Nuxt integration for the Abracadabra client, providing seamless SSR-compatible integration with reactive composables.

## Installation & Setup

### 1. Install the Client Package

```bash
npm install @abracadabra/client yjs y-indexeddb y-webrtc @hocuspocus/provider
```

### 2. Configure Nuxt

Add the plugin and configuration to your `nuxt.config.ts`:

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  // Client-only plugin to avoid SSR issues
  plugins: [
    { src: '~/plugins/abracadabra.client.ts', mode: 'client' }
  ],

  // Runtime config for environment variables
  runtimeConfig: {
    public: {
      abracadabraServerUrl: process.env.ABRACADABRA_SERVER_URL || 'http://localhost:8787',
      abracadabraWsUrl: process.env.ABRACADABRA_WS_URL || 'ws://localhost:8787/collaborate',
      abracadabraRoomName: process.env.ABRACADABRA_ROOM || 'default',
      abracadabraEnableOffline: process.env.ABRACADABRA_ENABLE_OFFLINE !== 'false',
      abracadabraEnableWebRTC: process.env.ABRACADABRA_ENABLE_WEBRTC === 'true',
      abracadabraAutoReconnect: process.env.ABRACADABRA_AUTO_RECONNECT !== 'false'
    }
  },

  // CSS for Abracadabra components (optional)
  css: ['~/assets/css/abracadabra.css']
})
```

### 3. Create the Plugin

Create `plugins/abracadabra.client.ts`:

```typescript
// plugins/abracadabra.client.ts
import { AbracadabraClientManager } from '@abracadabra/client'
import type { AbracadabraClientConfig } from '@abracadabra/client'

export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig()
  
  const clientConfig: AbracadabraClientConfig = {
    serverUrl: config.public.abracadabraServerUrl,
    hocuspocusUrl: config.public.abracadabraWsUrl,
    roomName: config.public.abracadabraRoomName || 'default',
    enableOffline: config.public.abracadabraEnableOffline ?? true,
    enableWebRTC: config.public.abracadabraEnableWebRTC ?? false,
    autoReconnect: config.public.abracadabraAutoReconnect ?? true
  }

  const client = AbracadabraClientManager.getInstance(clientConfig)

  try {
    await AbracadabraClientManager.connect()
  } catch (error) {
    console.warn('Failed to connect to Abracadabra server:', error)
  }

  // Global error handling
  client.on('auth:error', (error) => {
    console.error('Authentication error:', error.message)
  })

  client.on('connection:error', (error) => {
    console.warn('Connection error:', error.message)
  })

  return {
    provide: {
      abracadabra: client,
      abracadabraManager: AbracadabraClientManager
    }
  }
})
```

### 4. Add Composables

Copy the composables file to your project:

```bash
cp src/nuxt/composables.ts composables/useAbracadabra.ts
```

## Usage Examples

### Authentication

```vue
<template>
  <div>
    <div v-if="!isAuthenticated" class="login-form">
      <form @submit.prevent="handleLogin">
        <input 
          v-model="credentials.identifier" 
          placeholder="Username or Email" 
          required 
        />
        <input 
          v-model="credentials.password" 
          type="password" 
          placeholder="Password" 
          required 
        />
        <button :disabled="loading" type="submit">
          {{ loading ? 'Logging in...' : 'Login' }}
        </button>
      </form>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
    
    <div v-else class="user-info">
      <h2>Welcome, {{ user?.displayName }}!</h2>
      <button @click="logout">Logout</button>
    </div>
  </div>
</template>

<script setup>
const { user, isAuthenticated, loading, error, login, logout } = useAbracadabraAuth()

const credentials = ref({
  identifier: '',
  password: ''
})

const handleLogin = async () => {
  try {
    await login(credentials.value)
    credentials.value = { identifier: '', password: '' }
  } catch (err) {
    console.error('Login failed:', err)
  }
}
</script>
```

### Document Management

```vue
<template>
  <div>
    <div v-if="loading">Loading document...</div>
    <div v-else-if="error">Error: {{ error.message }}</div>
    <div v-else-if="doc">
      <h1>{{ metadata?.title || 'Untitled Document' }}</h1>
      
      <!-- Yjs-powered text editor -->
      <div id="editor" ref="editorRef"></div>
      
      <!-- Document metadata -->
      <div class="metadata">
        <label>
          Title:
          <input v-model="title" @blur="saveMetadata" />
        </label>
        <label>
          Description:
          <textarea v-model="description" @blur="saveMetadata"></textarea>
        </label>
        <label>
          <input 
            v-model="isPublic" 
            type="checkbox" 
            @change="saveMetadata"
          />
          Public Document
        </label>
      </div>
      
      <!-- Sync status -->
      <div class="sync-status">
        <span v-if="syncing">Saving...</span>
        <span v-else>Saved</span>
      </div>
    </div>
  </div>
</template>

<script setup>
const route = useRoute()
const documentPath = route.params.path as string

const { 
  doc, 
  metadata, 
  loading, 
  error, 
  syncing, 
  save 
} = useDocument(documentPath)

// Reactive metadata
const title = ref('')
const description = ref('')
const isPublic = ref(false)

// Update local state when metadata changes
watch(metadata, (newMetadata) => {
  if (newMetadata) {
    title.value = newMetadata.title || ''
    description.value = newMetadata.description || ''
    isPublic.value = newMetadata.isPublic
  }
}, { immediate: true })

// Save metadata changes
const saveMetadata = async () => {
  if (!metadata.value) return
  
  try {
    await save({
      title: title.value,
      description: description.value,
      isPublic: isPublic.value
    })
  } catch (err) {
    console.error('Failed to save metadata:', err)
  }
}

// Setup Yjs text editor (example with a simple textarea)
const editorRef = ref<HTMLElement>()

onMounted(() => {
  if (doc.value && editorRef.value) {
    const ytext = doc.value.getText('content')
    
    // Simple text editor example
    const textarea = document.createElement('textarea')
    textarea.value = ytext.toString()
    textarea.style.width = '100%'
    textarea.style.height = '400px'
    
    // Bind Yjs text to textarea
    let updating = false
    
    ytext.observe(() => {
      if (!updating) {
        updating = true
        textarea.value = ytext.toString()
        updating = false
      }
    })
    
    textarea.addEventListener('input', () => {
      if (!updating) {
        updating = true
        ytext.delete(0, ytext.length)
        ytext.insert(0, textarea.value)
        updating = false
      }
    })
    
    editorRef.value.appendChild(textarea)
  }
})
</script>
```

### Document Tree Navigation

```vue
<template>
  <div class="document-tree">
    <h2>Document Tree</h2>
    
    <!-- Search -->
    <div class="search">
      <input 
        v-model="searchQuery" 
        placeholder="Search documents..." 
        @keyup.enter="handleSearch"
      />
      <button @click="handleSearch">Search</button>
    </div>
    
    <!-- Create new document -->
    <div class="create-document">
      <input 
        v-model="newDocPath" 
        placeholder="New document path" 
      />
      <button @click="handleCreate">Create Document</button>
    </div>
    
    <!-- Document list -->
    <div v-if="loading" class="loading">Loading documents...</div>
    <div v-else-if="error" class="error">Error: {{ error }}</div>
    <div v-else class="document-list">
      <div 
        v-for="document in filteredDocuments" 
        :key="document.path"
        class="document-item"
        @click="navigateToDocument(document.path)"
      >
        <div class="document-info">
          <h3>{{ document.title || document.path }}</h3>
          <p>{{ document.description }}</p>
          <div class="document-meta">
            <span>Size: {{ formatFileSize(document.size) }}</span>
            <span>Modified: {{ formatDate(document.updatedAt) }}</span>
            <span v-if="document.isPublic" class="public-badge">Public</span>
          </div>
        </div>
        
        <div class="document-actions">
          <button @click.stop="deleteDocument(document.path)">Delete</button>
        </div>
      </div>
    </div>
    
    <!-- Search results -->
    <div v-if="searchResults.length > 0" class="search-results">
      <h3>Search Results</h3>
      <div 
        v-for="result in searchResults" 
        :key="result.path"
        class="document-item"
        @click="navigateToDocument(result.path)"
      >
        <h4>{{ result.title || result.path }}</h4>
        <p>{{ result.description }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
const { 
  documents, 
  loading, 
  error, 
  fetchDocuments,
  createDocument,
  deleteDocument: removeDocument,
  searchDocuments 
} = useDocumentTree()

const searchQuery = ref('')
const searchResults = ref([])
const newDocPath = ref('')

// Filter documents based on current view
const filteredDocuments = computed(() => {
  // You can add filtering logic here based on current folder, etc.
  return documents.value
})

const handleSearch = async () => {
  if (!searchQuery.value.trim()) {
    searchResults.value = []
    return
  }
  
  try {
    searchResults.value = await searchDocuments(searchQuery.value, {
      limit: 20
    })
  } catch (err) {
    console.error('Search failed:', err)
  }
}

const handleCreate = async () => {
  if (!newDocPath.value.trim()) return
  
  try {
    await createDocument(newDocPath.value, {
      title: `New Document: ${newDocPath.value}`,
      description: 'A new collaborative document'
    })
    newDocPath.value = ''
  } catch (err) {
    console.error('Failed to create document:', err)
  }
}

const deleteDocument = async (path: string) => {
  if (confirm(`Are you sure you want to delete "${path}"?`)) {
    try {
      await removeDocument(path)
    } catch (err) {
      console.error('Failed to delete document:', err)
    }
  }
}

const navigateToDocument = (path: string) => {
  navigateTo(`/documents/${encodeURIComponent(path)}`)
}

const formatFileSize = (bytes: number) => {
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  if (bytes === 0) return '0 Bytes'
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i]
}

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString()
}
</script>
```

### File Upload

```vue
<template>
  <div class="file-upload">
    <div class="upload-area" @drop="handleDrop" @dragover.prevent>
      <input 
        ref="fileInput"
        type="file"
        multiple
        @change="handleFileSelect"
        style="display: none"
      />
      
      <button @click="$refs.fileInput.click()" :disabled="uploading">
        {{ uploading ? 'Uploading...' : 'Select Files' }}
      </button>
      
      <p>or drag and drop files here</p>
      
      <div v-if="uploading" class="progress">
        <div class="progress-bar" :style="{ width: progress + '%' }"></div>
        <span>{{ progress }}%</span>
      </div>
      
      <div v-if="error" class="error">{{ error }}</div>
    </div>
    
    <!-- File list -->
    <div v-if="files.length > 0" class="file-list">
      <h3>Uploaded Files</h3>
      <div v-for="file in files" :key="file.id" class="file-item">
        <div class="file-info">
          <strong>{{ file.originalName }}</strong>
          <span>{{ formatFileSize(file.size) }}</span>
          <span>{{ formatDate(file.createdAt) }}</span>
        </div>
        
        <div class="file-actions">
          <button @click="handleDownload(file.id)">Download</button>
          <button @click="handleDelete(file.id)">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps<{
  documentPath?: string
}>()

const { 
  uploading, 
  progress, 
  error, 
  upload, 
  listFiles,
  downloadFile,
  deleteFile 
} = useFileUpload()

const files = ref<FileMetadata[]>([])

const loadFiles = async () => {
  try {
    files.value = await listFiles(props.documentPath)
  } catch (err) {
    console.error('Failed to load files:', err)
  }
}

const handleFileSelect = (event: Event) => {
  const target = event.target as HTMLInputElement
  if (target.files) {
    handleFiles(Array.from(target.files))
  }
}

const handleDrop = (event: DragEvent) => {
  event.preventDefault()
  if (event.dataTransfer?.files) {
    handleFiles(Array.from(event.dataTransfer.files))
  }
}

const handleFiles = async (fileList: File[]) => {
  for (const file of fileList) {
    try {
      await upload(file, {
        documentPath: props.documentPath,
        description: `Uploaded file: ${file.name}`
      })
      await loadFiles() // Refresh file list
    } catch (err) {
      console.error('Upload failed:', err)
    }
  }
}

const handleDownload = async (fileId: string) => {
  try {
    const blob = await downloadFile(fileId)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = files.value.find(f => f.id === fileId)?.originalName || 'download'
    a.click()
    URL.revokeObjectURL(url)
  } catch (err) {
    console.error('Download failed:', err)
  }
}

const handleDelete = async (fileId: string) => {
  try {
    await deleteFile(fileId)
    await loadFiles() // Refresh file list
  } catch (err) {
    console.error('Delete failed:', err)
  }
}

const formatFileSize = (bytes: number) => {
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  if (bytes === 0) return '0 Bytes'
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i]
}

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString()
}

// Load files on mount
onMounted(loadFiles)
</script>
```

### Connection Status Monitor

```vue
<template>
  <div class="connection-monitor">
    <div class="status-indicator" :class="statusClass">
      <div class="status-dot"></div>
      <span>{{ statusText }}</span>
    </div>
    
    <div v-if="queueStatus.total > 0" class="queue-status">
      <span>Pending: {{ queueStatus.pending }}</span>
      <span v-if="queueStatus.failed > 0">Failed: {{ queueStatus.failed }}</span>
    </div>
    
    <div class="connection-details">
      <div>Server: {{ connectionStatus.hocuspocus ? '✅' : '❌' }}</div>
      <div>IndexedDB: {{ connectionStatus.indexeddb ? '✅' : '❌' }}</div>
      <div v-if="connectionStatus.webrtc !== undefined">
        WebRTC: {{ connectionStatus.webrtc ? '✅' : '❌' }}
      </div>
    </div>
  </div>
</template>

<script setup>
const { 
  isOnline, 
  connectionStatus, 
  queueStatus,
  retryOfflineOperation,
  cancelOfflineOperation 
} = useAbracadabraConnection()

const statusClass = computed(() => ({
  'status-online': isOnline.value && connectionStatus.value.hocuspocus,
  'status-offline': !isOnline.value,
  'status-connecting': isOnline.value && !connectionStatus.value.hocuspocus
}))

const statusText = computed(() => {
  if (!isOnline.value) return 'Offline'
  if (connectionStatus.value.hocuspocus) return 'Connected'
  return 'Connecting...'
})
</script>

<style scoped>
.connection-monitor {
  position: fixed;
  top: 10px;
  right: 10px;
  background: white;
  padding: 10px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  z-index: 1000;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ccc;
}

.status-online .status-dot {
  background: #4caf50;
}

.status-offline .status-dot {
  background: #f44336;
}

.status-connecting .status-dot {
  background: #ff9800;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
</style>
```

## Environment Variables

Create a `.env` file in your project root:

```env
# Server Configuration
ABRACADABRA_SERVER_URL=http://localhost:8787
ABRACADABRA_WS_URL=ws://localhost:8787/collaborate
ABRACADABRA_ROOM=default

# Feature Flags
ABRACADABRA_ENABLE_OFFLINE=true
ABRACADABRA_ENABLE_WEBRTC=false
ABRACADABRA_AUTO_RECONNECT=true
```

## Features

### ✅ Complete Feature Set

- **Authentication**: Login, logout, registration with reactive state
- **Document Management**: CRUD operations with offline support
- **File Upload/Download**: Complete file management with progress tracking  
- **Hierarchical Navigation**: Tree-based document organization
- **Permission Management**: Granular access control
- **Offline-First**: Automatic operation queuing and conflict resolution
- **Real-time Sync**: Live collaboration with Yjs
- **Connection Monitoring**: Real-time connection status and queue management
- **Admin Functions**: System management and statistics

### 🎯 Nuxt-Specific Benefits  

- **SSR Compatible**: Client-only plugin prevents hydration issues
- **Reactive Composables**: Vue 3 Composition API with full reactivity
- **Auto-imports**: All composables available globally
- **TypeScript Support**: Full type safety throughout
- **Environment Config**: Runtime configuration with .env support
- **Error Handling**: Comprehensive error states and recovery
- **Lifecycle Management**: Proper cleanup and resource management

## Best Practices

1. **Always handle loading states** - Use the `loading` reactive refs
2. **Implement error boundaries** - Check `error` refs and handle gracefully  
3. **Use offline indicators** - Show connection status to users
4. **Clean up resources** - Composables handle this automatically
5. **Handle permissions** - Check user permissions before operations
6. **Monitor queue status** - Show pending operations to users
7. **Use optimistic updates** - UI updates immediately, syncs when online

## Troubleshooting

### Connection Issues
- Check server URL configuration
- Verify WebSocket URL is accessible
- Check browser console for network errors

### SSR Issues  
- Ensure plugin is client-only
- Don't access client in server-side code
- Use `process.client` checks if needed

### Type Issues
- Import types from the main package
- Use proper TypeScript configuration
- Check composable return types

This integration provides a complete, production-ready solution for building collaborative applications with Nuxt and Abracadabra.