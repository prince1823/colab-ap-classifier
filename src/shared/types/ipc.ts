// Core IPC response envelope
export interface IPCResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  /** Error code from typed errors (e.g. LLMClientError.code) */
  code?: string;
}
