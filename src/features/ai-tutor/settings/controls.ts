/**
 * Stable identities, names and descriptions of the controls on Settings ▸ AI Tutor (Phase 5 Task 10).
 * The tooltips registry derives its entries from here.
 */
import type { TutorControlMeta } from '../panel/controls'

export const AI_SETTINGS_PAGE_ID = 'ai-tutor'

/** The note the page shows first (Global Constraints: Claude-subscription login is never implemented). */
export const SUBSCRIPTION_NOTE = "Claude subscriptions can't be used by other apps (Anthropic's rule). Use an API key or OpenRouter."
export const HISTORY_NOTE = 'Chats are saved on this computer with the text you attached.'

export const AI_SETTINGS_CONTROLS = {
  signIn: {
    id: 'aiSettings.signIn',
    label: 'Sign in with OpenRouter',
    description: 'Sign in to OpenRouter in your browser. Novel gets a key and keeps it in the keychain.',
  },
  signInChatGpt: {
    id: 'aiSettings.signIn.chatgpt',
    label: 'Continue with ChatGPT',
    description: 'Sign in to ChatGPT in your browser so the tutor can use your ChatGPT plan.',
  },
  signInOtherAccount: {
    id: 'aiSettings.signIn.chatgpt.other',
    label: 'Use Another Account',
    description: 'Sign in to ChatGPT with a different account than the one Novel used before.',
  },
  signInAgain: {
    id: 'aiSettings.signInAgain',
    label: 'Sign In Again',
    description: 'Renew this connection’s sign-in in your browser, with the same account.',
  },
  manageUsage: {
    id: 'aiSettings.manageUsage',
    label: 'Manage Usage',
    description: 'Open your plan’s usage settings in your browser, where you can see and limit what Novel uses.',
  },
  planWarningAccept: {
    id: 'aiSettings.planWarning.accept',
    label: 'Continue to Sign In',
    description: 'You have read the warning. Open the sign-in page in your browser.',
  },
  signInCancel: { id: 'aiSettings.signIn.cancel', label: 'Cancel Sign-in', description: 'Stop waiting for the browser. No connection is added.' },
  add: { id: 'aiSettings.add', label: 'Add Connection…', description: 'Connect the tutor to a provider with an API key, or to a model on this computer or your network.' },
  setDefault: { id: 'aiSettings.setDefault', label: 'Set as Default', description: 'The tutor uses this connection unless you choose another one in its panel.' },
  edit: { id: 'aiSettings.edit', label: 'Edit', description: 'Change this connection’s name, key, address or default model.' },
  remove: { id: 'aiSettings.remove', label: 'Remove', description: 'Remove this connection. Its saved key is deleted from this computer’s keychain.' },
  provider: { id: 'aiSettings.provider', label: 'Provider', description: 'Who runs the model: an AI company, a server on this computer, or any OpenAI-compatible address.' },
  label: { id: 'aiSettings.label', label: 'Name', description: 'What this connection is called in the tutor’s model menu.' },
  key: {
    id: 'aiSettings.key',
    label: 'API key',
    description: 'Paste your provider’s key. It goes to the keychain and is not shown again. Empty keeps the old one.',
  },
  getKey: { id: 'aiSettings.getKey', label: 'Get a Key', description: 'Open this provider’s page for creating an API key in your browser.' },
  baseUrl: {
    id: 'aiSettings.baseUrl',
    label: 'Server address',
    description: 'The server’s OpenAI-compatible address, usually ending in /v1. Plain http to another computer asks.',
  },
  test: {
    id: 'aiSettings.test',
    label: 'Test Connection',
    description: 'Save, then ask the provider for its models. For a local model, also check that it can use tools.',
  },
  defaultModel: { id: 'aiSettings.defaultModel', label: 'Default model', description: 'The model the tutor starts with on this connection. Test Connection lists them.' },
  toolsOverride: {
    id: 'aiSettings.toolsOverride',
    label: 'This model supports tools',
    description: 'Tick this if you know the model can call tools. The tutor needs them to read and correct your text.',
  },
  save: { id: 'aiSettings.save', label: 'Save Connection', description: 'Save this connection. A key you typed goes to the keychain, not to a file.' },
  cancel: { id: 'aiSettings.cancel', label: 'Cancel', description: 'Close the form without saving the changes.' },
  clearProject: {
    id: 'aiSettings.clearProject',
    label: "Clear This Project's Chats",
    description: 'Delete every tutor chat of the project that is open. This cannot be undone.',
  },
  clearAll: { id: 'aiSettings.clearAll', label: 'Clear All Chats', description: 'Delete every tutor chat of every project on this computer. This cannot be undone.' },
  insecureAccept: {
    id: 'aiSettings.insecure.accept',
    label: 'Use Unencrypted Address',
    description: 'Save this http address. What you send to it, attached text included, can be read on the network.',
  },
  removeConfirm: { id: 'aiSettings.remove.confirm', label: 'Remove Connection', description: 'Remove the connection and delete its saved key.' },
  clearProjectConfirm: { id: 'aiSettings.clearProject.confirm', label: "Clear This Project's Chats", description: "Delete this project's tutor chats now." },
  clearAllConfirm: { id: 'aiSettings.clearAll.confirm', label: 'Clear All Chats', description: 'Delete every tutor chat now.' },
  confirmNo: { id: 'aiSettings.confirm.no', label: 'Cancel', description: 'Leave things as they are.' },
} as const satisfies Record<string, TutorControlMeta>

export type AiSettingsControlKey = keyof typeof AI_SETTINGS_CONTROLS
