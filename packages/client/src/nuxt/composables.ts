import type { 
  AbracadabraClient, 
  AuthUser, 
  DocumentMetadata, 
  FileMetadata, 
  DocumentNode,
  SystemStats,
  PermissionLevel 
} from '../index'
import * as Y from 'yjs'

/**
 * Main composable for Abracadabra client access
 */
export const useAbracadabra = (): AbracadabraClient => {
  const { $abracadabra } = useNuxtApp()
  if (!$abracadabra) {
    throw new Error('Abracadabra client not initialized. Make sure the plugin is loaded.')
  }
  return $abracadabra as AbracadabraClient
}

/**
 * Authentication composable with reactive state management
 */
export const useAbracadabraAuth = () => {
  const client = useAbracadabra()
  const user = ref<AuthUser | null>(client.getCurrentUser())
  const isAuthenticated = ref(client.isAuthenticated())
  const loading = ref(false)
  const error = ref<string | null>(null)

  // Listen for auth changes
  onMounted(() => {
    const handleLogin = (newUser: AuthUser) => {
      user.value = newUser
      isAuthenticated.value = true
      error.value = null
    }

    const handleLogout = () => {
      user.value = null
      isAuthenticated.value = false
      error.value = null
    }

    const handleAuthError = (err: Error) => {
      error.value = err.message
      loading.value = false
    }

    client.on('auth:login', handleLogin)
    client.on('auth:logout', handleLogout)
    client.on('auth:error', handleAuthError)

    // Cleanup listeners
    onUnmounted(() => {
      client.off('auth:login', handleLogin)
      client.off('auth:logout', handleLogout)
      client.off('auth:error', handleAuthError)
    })
  })

  const login = async (credentials: { identifier: string; password: string }) => {
    loading.value = true
    error.value = null
    try {
      const result = await client.login(credentials)
      return result
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Login failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  const logout = async () => {
    loading.value = true
    error.value = null
    try {
      await client.logout()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Logout failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  const register = async (userData: {
    username: string
    email: string
    password: string
    displayName?: string
  }) => {
    loading.value = true
    error.value = null
    try {
      const result = await client.register(userData)
      return result
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Registration failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  const updateProfile = async (updates: {
    displayName?: string
    email?: string
    settings?: Record<string, any>
  }) => {
    loading.value = true
    error.value = null
    try {
      const updatedUser = await client.updateProfile(updates)
      user.value = updatedUser
      return updatedUser
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Profile update failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  const changePassword = async (oldPassword: string, newPassword: string) => {
    loading.value = true
    error.value = null
    try {
      await client.changePassword(oldPassword, newPassword)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Password change failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  return {
    user: readonly(user),
    isAuthenticated: readonly(isAuthenticated),
    loading: readonly(loading),
    error: readonly(error),
    login,
    logout,
    register,
    updateProfile,
    changePassword
  }
}

/**
 * Document management composable with offline support
 */
export const useDocument = (path: string) => {
  const client = useAbracadabra()
  const doc = ref<Y.Doc | null>(null)
  const metadata = ref<DocumentMetadata | null>(null)
  const loading = ref(true)
  const error = ref<Error | null>(null)
  const syncing = ref(false)

  const load = async () => {
    loading.value = true
    error.value = null
    
    try {
      // Load document and metadata in parallel
      const [yjsDoc] = await Promise.all([
        client.getDocument(path),
        refreshMetadata()
      ])

      doc.value = yjsDoc
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      console.error('Failed to load document:', path, err)
    } finally {
      loading.value = false
    }
  }

  const refreshMetadata = async () => {
    try {
      const documents = await client.fetchIndex()
      metadata.value = documents.find(d => d.path === path) || null
    } catch (err) {
      console.warn('Failed to refresh metadata for:', path, err)
    }
  }

  const save = async (updates: Partial<DocumentMetadata>) => {
    if (!metadata.value) return null
    
    syncing.value = true
    try {
      const updated = await client.updateDocument(path, updates)
      metadata.value = updated
      return updated
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      throw err
    } finally {
      syncing.value = false
    }
  }

  const remove = async () => {
    syncing.value = true
    try {
      await client.deleteDocument(path)
      doc.value = null
      metadata.value = null
    } catch (err) {
      error.value = err instanceof Error ? err : new Error(String(err))
      throw err
    } finally {
      syncing.value = false
    }
  }

  const getChildren = async () => {
    try {
      return await client.getChildren(path)
    } catch (err) {
      console.error('Failed to get children for:', path, err)
      return []
    }
  }

  const getBreadcrumbs = (): DocumentNode[] => {
    return client.getBreadcrumbs(path)
  }

  // Auto-load on mount
  onMounted(() => {
    load()

    // Listen for sync events
    const handleSyncStart = () => { syncing.value = true }
    const handleSyncComplete = () => { syncing.value = false }
    
    client.on('sync:start', handleSyncStart)
    client.on('sync:complete', handleSyncComplete)

    onUnmounted(() => {
      client.off('sync:start', handleSyncStart)
      client.off('sync:complete', handleSyncComplete)
    })
  })

  // Cleanup on unmount
  onUnmounted(() => {
    if (doc.value) {
      client.leaveDocument(path)
    }
  })

  return {
    doc: readonly(doc),
    metadata: readonly(metadata),
    loading: readonly(loading),
    error: readonly(error),
    syncing: readonly(syncing),
    load,
    save,
    remove,
    getChildren,
    getBreadcrumbs,
    refreshMetadata
  }
}

/**
 * Document hierarchy composable with tree management
 */
export const useDocumentTree = () => {
  const client = useAbracadabra()
  const documents = ref<DocumentMetadata[]>([])
  const loading = ref(true)
  const error = ref<string | null>(null)

  const fetchDocuments = async () => {
    loading.value = true
    error.value = null
    try {
      documents.value = await client.fetchIndex()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to fetch documents'
    } finally {
      loading.value = false
    }
  }

  const getChildren = async (parentPath: string) => {
    try {
      return await client.getChildren(parentPath)
    } catch (err) {
      console.error('Failed to get children:', err)
      return []
    }
  }

  const getBreadcrumbs = (path: string) => {
    return client.getBreadcrumbs(path)
  }

  const createDocument = async (
    path: string, 
    options: {
      title?: string
      description?: string
      initialContent?: string
      isPublic?: boolean
    } = {}
  ) => {
    try {
      const newDoc = await client.createDocument(path, options)
      await fetchDocuments() // Refresh the tree
      return newDoc
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to create document')
    }
  }

  const deleteDocument = async (path: string) => {
    try {
      await client.deleteDocument(path)
      await fetchDocuments() // Refresh the tree
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to delete document')
    }
  }

  const searchDocuments = async (query: string, options: {
    limit?: number
    offset?: number
    onlyPublic?: boolean
  } = {}) => {
    try {
      return await client.searchDocuments(query, options)
    } catch (err) {
      console.error('Search failed:', err)
      return []
    }
  }

  // Auto-load on mount
  onMounted(fetchDocuments)

  return {
    documents: readonly(documents),
    loading: readonly(loading),
    error: readonly(error),
    fetchDocuments,
    getChildren,
    getBreadcrumbs,
    createDocument,
    deleteDocument,
    searchDocuments
  }
}

/**
 * File upload composable with progress tracking
 */
export const useFileUpload = () => {
  const client = useAbracadabra()
  const uploading = ref(false)
  const progress = ref(0)
  const error = ref<string | null>(null)

  const upload = async (
    file: File,
    options: {
      description?: string
      tags?: string[]
      documentPath?: string
    } = {}
  ) => {
    uploading.value = true
    progress.value = 0
    error.value = null

    try {
      // TODO: Add progress tracking with XMLHttpRequest if needed
      const result = await client.uploadFile(file, options)
      progress.value = 100
      return result
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Upload failed'
      throw err
    } finally {
      uploading.value = false
    }
  }

  const listFiles = async (documentPath?: string) => {
    try {
      return await client.listFiles({ documentPath })
    } catch (err) {
      console.error('Failed to list files:', err)
      return []
    }
  }

  const downloadFile = async (fileId: string) => {
    try {
      return await client.downloadFile(fileId)
    } catch (err) {
      console.error('Failed to download file:', err)
      throw err
    }
  }

  const deleteFile = async (fileId: string) => {
    try {
      await client.deleteFile(fileId)
    } catch (err) {
      console.error('Failed to delete file:', err)
      throw err
    }
  }

  const getFilesByDocument = async (documentPath: string) => {
    try {
      return await client.getFilesByDocument(documentPath)
    } catch (err) {
      console.error('Failed to get files by document:', err)
      return []
    }
  }

  return {
    uploading: readonly(uploading),
    progress: readonly(progress),
    error: readonly(error),
    upload,
    listFiles,
    downloadFile,
    deleteFile,
    getFilesByDocument
  }
}

/**
 * Permission management composable
 */
export const useDocumentPermissions = (path: string) => {
  const client = useAbracadabra()
  const permissions = ref<any>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const loadPermissions = async () => {
    loading.value = true
    error.value = null
    try {
      permissions.value = await client.getDocumentPermissions(path)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to load permissions'
    } finally {
      loading.value = false
    }
  }

  const updatePermissions = async (updates: any) => {
    loading.value = true
    error.value = null
    try {
      const updated = await client.updateDocumentPermissions(path, updates)
      permissions.value = updated
      return updated
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to update permissions'
      throw err
    } finally {
      loading.value = false
    }
  }

  const grantPermission = async (username: string, level: PermissionLevel) => {
    loading.value = true
    error.value = null
    try {
      await client.grantPermission(path, username, level)
      await loadPermissions() // Refresh permissions
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to grant permission'
      throw err
    } finally {
      loading.value = false
    }
  }

  const revokePermission = async (username: string) => {
    loading.value = true
    error.value = null
    try {
      await client.revokePermission(path, username)
      await loadPermissions() // Refresh permissions
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to revoke permission'
      throw err
    } finally {
      loading.value = false
    }
  }

  // Auto-load on mount
  onMounted(loadPermissions)

  return {
    permissions: readonly(permissions),
    loading: readonly(loading),
    error: readonly(error),
    loadPermissions,
    updatePermissions,
    grantPermission,
    revokePermission
  }
}

/**
 * Connection status composable
 */
export const useAbracadabraConnection = () => {
  const client = useAbracadabra()
  const isOnline = ref(client.isOnlineStatus())
  const connectionStatus = ref(client.getConnectionStatus())
  const queueStatus = ref(client.getOfflineQueueStatus())
  
  onMounted(() => {
    const handleOnline = () => {
      isOnline.value = true
      connectionStatus.value = client.getConnectionStatus()
      queueStatus.value = client.getOfflineQueueStatus()
    }

    const handleOffline = () => {
      isOnline.value = false
      connectionStatus.value = client.getConnectionStatus()
    }

    const handleConnectionOpen = () => {
      connectionStatus.value = client.getConnectionStatus()
    }

    const handleConnectionClose = () => {
      connectionStatus.value = client.getConnectionStatus()
    }

    const handleSyncComplete = () => {
      queueStatus.value = client.getOfflineQueueStatus()
    }

    client.on('online', handleOnline)
    client.on('offline', handleOffline)
    client.on('connection:open', handleConnectionOpen)
    client.on('connection:close', handleConnectionClose)
    client.on('sync:complete', handleSyncComplete)

    // Update status periodically
    const interval = setInterval(() => {
      connectionStatus.value = client.getConnectionStatus()
      queueStatus.value = client.getOfflineQueueStatus()
    }, 5000)

    onUnmounted(() => {
      client.off('online', handleOnline)
      client.off('offline', handleOffline)
      client.off('connection:open', handleConnectionOpen)
      client.off('connection:close', handleConnectionClose)
      client.off('sync:complete', handleSyncComplete)
      clearInterval(interval)
    })
  })

  const retryOfflineOperation = async (operationId: string) => {
    try {
      await client.retryOfflineOperation(operationId)
      queueStatus.value = client.getOfflineQueueStatus()
    } catch (err) {
      console.error('Failed to retry operation:', err)
      throw err
    }
  }

  const cancelOfflineOperation = async (operationId: string) => {
    try {
      await client.cancelOfflineOperation(operationId)
      queueStatus.value = client.getOfflineQueueStatus()
    } catch (err) {
      console.error('Failed to cancel operation:', err)
      throw err
    }
  }

  return {
    isOnline: readonly(isOnline),
    connectionStatus: readonly(connectionStatus),
    queueStatus: readonly(queueStatus),
    retryOfflineOperation,
    cancelOfflineOperation
  }
}

/**
 * Admin composable for system administration
 */
export const useAbracadabraAdmin = () => {
  const client = useAbracadabra()
  const loading = ref(false)
  const error = ref<string | null>(null)

  const getSystemStats = async (): Promise<SystemStats | null> => {
    loading.value = true
    error.value = null
    try {
      return await client.getSystemStats()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to get system stats'
      return null
    } finally {
      loading.value = false
    }
  }

  const getUsers = async (options: {
    limit?: number
    offset?: number
    search?: string
  } = {}) => {
    loading.value = true
    error.value = null
    try {
      return await client.listUsers(options)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to get users'
      return []
    } finally {
      loading.value = false
    }
  }

  const getConfig = async () => {
    loading.value = true
    error.value = null
    try {
      return await client.admin.getConfig()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to get config'
      return null
    } finally {
      loading.value = false
    }
  }

  const updateConfig = async (config: Record<string, any>) => {
    loading.value = true
    error.value = null
    try {
      return await client.admin.updateConfig(config)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to update config'
      throw err
    } finally {
      loading.value = false
    }
  }

  const performMaintenance = async (operation: 'cleanup' | 'optimize' | 'backup' | 'migrate') => {
    loading.value = true
    error.value = null
    try {
      return await client.admin.performMaintenance(operation)
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Maintenance operation failed'
      throw err
    } finally {
      loading.value = false
    }
  }

  const getHealthStatus = async () => {
    loading.value = true
    error.value = null
    try {
      return await client.admin.getHealthStatus()
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to get health status'
      return null
    } finally {
      loading.value = false
    }
  }

  return {
    loading: readonly(loading),
    error: readonly(error),
    getSystemStats,
    getUsers,
    getConfig,
    updateConfig,
    performMaintenance,
    getHealthStatus
  }
}