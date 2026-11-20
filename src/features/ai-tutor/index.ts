// Public surface of the ai-tutor slice (Phase 5). Other slices import only from here.
export { AiFetchError, createTauriFetch, type AiErrorKind } from './net/tauri-fetch'
export { PROVIDER_IDS, USER_HOSTED_PROVIDERS, type Connection, type ProviderId } from './connections/types'
export { getTutorConnections, loadTutorConnections, saveTutorConnections, setActiveTutorConnection } from './connections/store'
export { setSecret, deleteSecret, hasSecret } from './connections/ipc'
