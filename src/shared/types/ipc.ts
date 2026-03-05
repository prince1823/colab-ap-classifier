// Core IPC response envelope
export interface IPCResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
