import { Socket } from "node:net";
import { randomUUID } from "node:crypto";

export interface BridgeRequest {
  cmd: string;
  params?: Record<string, unknown>;
