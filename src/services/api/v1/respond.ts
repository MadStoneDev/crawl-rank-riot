// v1 response envelope helpers. Every v1 response — success or error — carries
// api_version + schema_version so a client can assert what it parsed.

import { Response } from "express";
import { API_VERSION, SCHEMA_VERSION } from "./version";
import type { V1Envelope, V1Error } from "./schemas";

export function v1Envelope<T>(data: T): V1Envelope<T> {
  return { api_version: API_VERSION, schema_version: SCHEMA_VERSION, data };
}

export function sendV1<T>(res: Response, status: number, data: T): void {
  res.status(status).json(v1Envelope(data));
}

export function sendV1Error(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const body: V1Error = {
    api_version: API_VERSION,
    schema_version: SCHEMA_VERSION,
    error: { code, message, ...(details !== undefined ? { details } : {}) },
  };
  res.status(status).json(body);
}
