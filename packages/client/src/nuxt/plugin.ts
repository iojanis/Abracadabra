import { AbracadabraClientManager } from '../index'
import type { AbracadabraClientConfig } from '../index'

/**
 * Nuxt plugin for Abracadabra client integration
 * Provides singleton client instance across the application
 */
export default defineNuxtPlugin(async () => {
  const config = useRuntimeConfig()
  
  // Initialize singleton client with runtime config
  const clientConfig: AbracadabraClientConfig = {
    serverUrl: config.public.abracadabraServerUrl as string || 'http://localhost:8787',
    hocuspocusUrl: config.public.abracadabraWsUrl as string || 'ws://localhost:8787/collaborate',
    roomName: config.public.abracadabraRoomName as string || 'default',
    enableOffline: config.public.abracadabraEnableOffline as boolean ?? true,
    enableWebRTC: config.public.abracadabraEnableWebRTC as boolean ?? false,
    autoReconnect: config.public.abracadabraAutoReconnect as boolean ?? true
  }

  const client = AbracadabraClientManager.getInstance(clientConfig)

  // Connect and handle errors gracefully
  try {
    await AbracadabraClientManager.connect()
    console.log('✅ Abracadabra client connected successfully')
  } catch (error) {
    console.warn('⚠️ Failed to connect to Abracadabra server:', error)
    // Don't throw - allow app to work offline
  }

  // Setup global error handling
  client.on('auth:error', (error) => {
    console.error('🔐 Authentication error:', error.message)
    // Could redirect to login page or show notification
  })

  client.on('connection:error', (error) => {
    console.warn('📡 Connection error:', error.message)
    // Could show connection status indicator
  })

  client.on('sync:conflict', ({ operation, serverData, clientData }) => {
    console.warn('⚡ Sync conflict detected:', {
      operation: operation.endpoint,
      strategy: 'merge' // or show user prompt
    })
  })

  client.on('offline', () => {
    console.log('📴 Application is now offline')
  })

  client.on('online', () => {
    console.log('📶 Application is back online')
  })

  // Provide client and manager globally
  return {
    provide: {
      abracadabra: client,
      abracadabraManager: AbracadabraClientManager
    }
  }
})