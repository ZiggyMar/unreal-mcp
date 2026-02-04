import { Socket } from "node:net";
import { randomUUID } from "node:crypto";

export interface BridgeRequest {
  cmd: string;
  params?: Record<string, unknown>;
}

export interface BridgeResponse<T = unknown> {
  id?: string;
  ok: boolean;
  result?: T;
  error?: string;
}

export interface BridgeClientOptions {
  host?: string;
  port?: number;
  /** Milliseconds to wait for a response before rejecting. */
  timeoutMs?: number;
}

/**
 * Thin client for the UnrealMCPBridge editor plugin's local TCP protocol:
 * one line of JSON in, one line of JSON out, per request, on a fresh
 * connection. The bridge is single-threaded on the Unreal game thread, so
 * we keep this dead simple rather than pooling/pipelining connections.
 */
export class UnrealBridgeClient {
  private readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;

  constructor(options: BridgeClientOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8765;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async send<T = unknown>(cmd: string, params?: Record<string, unknown>): Promise<T> {
    const id = randomUUID();
    const requestLine = JSON.stringify({ id, cmd, params: params ?? {} }) + "\n";

    return await new Promise<T>((resolve, reject) => {
      const socket = new Socket();
      let buffer = "";
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };

      const succeed = (value: T) => {
        if (settled) return;
        settled = true;
