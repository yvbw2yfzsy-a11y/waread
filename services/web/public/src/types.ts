// Data model used by the frontend.
//
// The shapes below are what the UI works with. The wire format is documented in
// services/web/routes.md; src/api.ts maps it into these types in one place
// (e.g. API type "voice" <-> UI type "audio", direction "in"/"out" <-> fromMe).

export type ConnState = 'connected' | 'connecting' | 'disconnected' | 'needs_qr';

export interface StatusInfo {
  state: ConnState;
  since?: number;
}

export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'other';

export interface MediaInfo {
  mimeType?: string;
  size?: number;
  durationSec?: number;
  fileName?: string;
  pages?: number;
  width?: number;
  height?: number;
  /** 0..100 per bar, as delivered by WhatsApp for voice notes. Optional. */
  waveform?: number[];
  /** Missing status is treated as "ready". The API's "downloading" is shown like "pending". */
  status?: 'pending' | 'ready' | 'failed' | 'skipped' | 'expired';
  /** True -> a thumbnail can be fetched with api.thumbUrl(). */
  hasThumbnail?: boolean;
}

export interface QuotedRef {
  id?: string;
  senderName?: string;
  fromMe?: boolean;
  text?: string;
  type?: MessageType;
}

export interface Message {
  id: string;
  chatId: string;
  /** Raw WhatsApp timestamp as delivered by the API (seconds or milliseconds). */
  waTimestamp: number;
  fromMe: boolean;
  senderName?: string;
  type: MessageType;
  text?: string;
  caption?: string;
  quoted?: QuotedRef;
  media?: MediaInfo;
  /** Local "seen" state. null/undefined = new (yellow). */
  seenAt?: number | null;
  /** Local "played" state for voice notes. */
  playedAt?: number | null;
  deleted?: boolean;
}

export interface ChatPreview {
  type: MessageType;
  text: string;
  durationSec?: number;
  pages?: number;
  fromMe?: boolean;
  sender?: string;
}

export interface Chat {
  id: string;
  name: string;
  isGroup: boolean;
  /** Digits only, no "+". Needed for the wa.me link of one-to-one chats. */
  phone?: string;
  avatarUrl?: string;
  lastMessageAt: number;
  preview: ChatPreview;
  unreadCount: number;
}

/** "off" = store the message, do not download the file. */
export type DownloadMode = 'auto' | 'off';
export type DownloadKind = 'image' | 'audio' | 'video' | 'document';
export type DownloadRules = Record<DownloadKind, DownloadMode>;
export type DownloadMaxMb = Record<DownloadKind, number>;

export interface Settings {
  retentionDays: number;
  retentionMediaDays: number;
  storageLimitMb: number;
  downloadRules: DownloadRules;
  /** Size limit per kind in MB (files above it are not downloaded). */
  downloadMaxMb: DownloadMaxMb;
}

export interface StorageUsage {
  /** Media files plus database file. */
  totalBytes: number;
  perChat: { id: string; name: string; bytes: number }[];
  perType: { type: string; bytes: number }[];
}

export type SearchType = '' | 'text' | 'image' | 'audio' | 'video' | 'document';

export interface SearchFilters {
  q: string;
  chatId: string;
  type: SearchType;
  /** yyyy-mm-dd from <input type="date"> or empty */
  from: string;
  to: string;
  onlyNew: boolean;
}

export interface SearchHit {
  message: Message;
  chatName?: string;
}

export type ClearScope = 'chat' | 'media' | 'all';

export interface SseHandlers {
  onNewMessage(chatId: string, message: Message): void;
  onMessageUpdated(u: { messageId: string; seenAt?: number | null; playedAt?: number | null; deleted?: boolean }): void;
  onMediaReady(u: { messageId: string; status?: MediaInfo['status']; thumbnailPath?: string; filePath?: string }): void;
  onConnectionStatus(s: StatusInfo): void;
  onCleanupDone(u: { deletedMessages: number; deletedMedia: number }): void;
  /** History batch arrived after pairing: it creates no per-message events, so reload the chat list. */
  onHistorySynced(u: { stored: number }): void;
  onOpen(isReconnect: boolean): void;
  onDown(): void;
}

// ---- Passkey lock (WebAuthn) ----

export interface AuthState {
  /** Password login is switched off; only passkeys are accepted. */
  lock: boolean;
  /** At least one passkey exists and the server is configured for them. */
  passkey: boolean;
}

export interface PasskeyInfo {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  backupEligible: boolean;
  backupState: boolean;
}

export interface PasskeyOverview {
  configured: boolean;
  rpId: string | null;
  origin: string | null;
  lock: boolean;
  sessionHours: number;
  passkeys: PasskeyInfo[];
}

export type PasskeyStepPurpose = 'lock_on' | 'lock_off' | 'register' | 'delete';
